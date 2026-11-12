#!/usr/bin/env python3
"""Offline, no-overwrite SQLite + flat-image backup, verification and restore.

Requires Python 3 stdlib; run during a verified maintenance/quiesced period.
No account tokens, connection strings, or live CEI files are built into this tool.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
from urllib.parse import quote

SAFE_FILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$')


class OpsError(Exception):
    pass


def absolute(raw, kind):
    p = Path(raw)
    if not p.is_absolute() or '..' in p.parts:
        raise OpsError(f'{kind} deve ser um caminho absoluto sem segmentos ..')
    if str(p) in ('/', '/tmp', '/var', '/home', '/srv', '/opt'):
        raise OpsError(f'{kind} não pode ser um diretório raiz/genérico')
    return p


def check_no_symlinks(path, kind):
    """Reject symlinks in existing ancestors, not only the leaf."""
    p = Path(os.path.abspath(path))
    for part in [p, *p.parents]:
        if part.is_symlink():
            raise OpsError(f'{kind}: link simbólico não é permitido')


def regular(path, kind):
    check_no_symlinks(path, kind)
    try:
        st = path.stat()
    except FileNotFoundError:
        raise OpsError(f'{kind}: origem ausente') from None
    if not stat.S_ISREG(st.st_mode):
        raise OpsError(f'{kind}: origem não é arquivo regular')


def directory(path, kind):
    check_no_symlinks(path, kind)
    if not path.is_dir():
        raise OpsError(f'{kind}: diretório ausente/inválido')


def image_files(root):
    directory(root, 'imagens')
    result = []
    for item in root.iterdir():
        if not SAFE_FILE.fullmatch(item.name) or item.name in ('.', '..'):
            raise OpsError('arquivo de imagem com nome não permitido')
        regular(item, 'imagem')
        result.append(item)
    return sorted(result, key=lambda p: p.name)


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as handle:
        for part in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def db_connect_ro(file):
    regular(file, 'SQLite')
    # URI read-only: never silently create a new empty DB when source is missing.
    return sqlite3.connect('file:' + quote(str(file)) + '?mode=ro', uri=True)


def db_integrity(file):
    try:
        with db_connect_ro(file) as db:
            result = db.execute('PRAGMA integrity_check').fetchone()
    except sqlite3.Error as exc:
        raise OpsError('SQLite ilegível ou inválido') from exc
    if not result or result[0] != 'ok':
        raise OpsError('integridade SQLite não aprovada')


def entry(file):
    return {'sha256': digest(file), 'bytes': file.stat().st_size}


def safe_new_dest(dest, kind):
    check_no_symlinks(dest, kind)
    if dest.exists() or dest.is_symlink():
        raise OpsError(f'{kind}: destino já existe; operação sem sobrescrita')
    if not dest.parent.is_dir():
        raise OpsError(f'{kind}: diretório pai deve existir')


def backup(args):
    if not args.quiesced:
        raise OpsError('backup conjunto exige --quiesced (interromper escritas antes)')
    db = absolute(args.db, 'SQLite')
    uploads = absolute(args.uploads, 'imagens')
    output = absolute(args.output, 'backup')
    regular(db, 'SQLite')
    pics = image_files(uploads)
    db_integrity(db)
    safe_new_dest(output, 'backup')
    if output == uploads or uploads in output.parents or output in uploads.parents:
        raise OpsError('backup não pode ficar dentro da pasta de imagens')
    if output == db or db in output.parents:
        raise OpsError('backup não pode conter o banco original')
    os.mkdir(output, 0o700)
    try:
        os.mkdir(output / 'uploads', 0o700)
        with db_connect_ro(db) as source:
            with sqlite3.connect(output / 'sqlite.db') as dest:
                source.backup(dest)
        os.chmod(output / 'sqlite.db', 0o600)
        db_integrity(output / 'sqlite.db')
        images = {}
        for pic in pics:
            dest = output / 'uploads' / pic.name
            shutil.copyfile(pic, dest, follow_symlinks=False)
            os.chmod(dest, 0o600)
            images[pic.name] = entry(dest)
        data = {'format': 1, 'db': entry(output / 'sqlite.db'), 'images': images,
                'consistency': 'operator-confirmed-quiesced'}
        with (output / 'manifest.json').open('x', encoding='utf-8') as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write('\n')
        os.chmod(output / 'manifest.json', 0o600)
        print('BACKUP_OK: snapshot SQLite íntegro + imagens; arquivos=' + str(len(images)))
    except Exception:
        # Only a newly-created, exclusively-owned snapshot is removed.
        shutil.rmtree(output)
        raise


def verify(snapshot):
    directory(snapshot, 'snapshot')
    manifest = snapshot / 'manifest.json'
    regular(manifest, 'manifest')
    try:
        data = json.loads(manifest.read_text(encoding='utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        raise OpsError('manifest inválido') from exc
    if data.get('format') != 1 or not isinstance(data.get('images'), dict):
        raise OpsError('formato do snapshot não suportado')
    sqlitefile = snapshot / 'sqlite.db'
    regular(sqlitefile, 'SQLite do snapshot')
    db_integrity(sqlitefile)
    if entry(sqlitefile) != data.get('db'):
        raise OpsError('checksum de SQLite divergente')
    folder = snapshot / 'uploads'
    actual = image_files(folder)
    if set(pic.name for pic in actual) != set(data['images']):
        raise OpsError('quantidade/nomes de imagens divergem do manifest')
    for pic in actual:
        if entry(pic) != data['images'].get(pic.name):
            raise OpsError('checksum de imagem divergente')
    return data


def restore(args):
    snapshot = absolute(args.snapshot, 'snapshot')
    db = absolute(args.db, 'SQLite destino')
    uploads = absolute(args.uploads, 'imagens destino')
    data = verify(snapshot)
    safe_new_dest(db, 'SQLite destino')
    safe_new_dest(uploads, 'imagens destino')
    if db == uploads or db in uploads.parents or uploads in db.parents:
        raise OpsError('destinos SQLite e imagens devem ser distintos')
    if snapshot == uploads or snapshot in uploads.parents or uploads in snapshot.parents:
        raise OpsError('snapshot não pode ser destino de restauração')
    if snapshot == db or snapshot in db.parents:
        raise OpsError('SQLite destino não pode ser parte do snapshot')
    if not args.apply:
        print('RESTORE_DRY_RUN_OK: destinos ausentes e snapshot verificado; arquivos=' + str(len(data['images'])))
        return
    if not args.quiesced:
        raise OpsError('restauração requer --quiesced e serviço parado')
    # Destinations must not exist, so even a failed operation cannot overwrite user data.
    created_db = False
    created_uploads = False
    try:
        with (snapshot / 'sqlite.db').open('rb') as src, db.open('xb') as dst:
            created_db = True
            shutil.copyfileobj(src, dst)
        os.chmod(db, 0o600)
        uploads.mkdir(mode=0o700)
        created_uploads = True
        for name in data['images']:
            with (snapshot / 'uploads' / name).open('rb') as src, (uploads / name).open('xb') as dst:
                shutil.copyfileobj(src, dst)
            os.chmod(uploads / name, 0o600)
        db_integrity(db)
        if entry(db) != data['db']:
            raise OpsError('SQLite restaurado não corresponde ao snapshot')
        if {p.name: entry(p) for p in image_files(uploads)} != data['images']:
            raise OpsError('imagens restauradas não correspondem ao snapshot')
        print('RESTORE_OK: novos destinos verificados; arquivos=' + str(len(data['images'])))
    except Exception:
        # Roll back only paths this command created, never pre-existing paths.
        if created_uploads:
            shutil.rmtree(uploads)
        if created_db:
            db.unlink()
        raise


def migrate_images(args):
    source = absolute(args.source, 'pasta legada')
    target = absolute(args.target, 'pasta externa')
    if source == target or source in target.parents or target in source.parents:
        raise OpsError('origem e destino devem ser diretórios separados')
    pictures = image_files(source)
    directory(target, 'pasta externa')
    existing = {p.name: p for p in image_files(target)}
    to_copy = []
    for pic in pictures:
        if pic.name in existing:
            if entry(pic) != entry(existing[pic.name]):
                raise OpsError('colisão de nome e conteúdo: operação bloqueada sem sobrescrever')
        else:
            to_copy.append(pic)
    if not args.apply:
        print('MIGRATE_DRY_RUN_OK: copiar=' + str(len(to_copy)) + ' preservados=' + str(len(pictures)-len(to_copy)))
        return
    for pic in to_copy:
        try:
            with pic.open('rb') as src, (target / pic.name).open('xb') as dst:
                shutil.copyfileobj(src, dst)
            os.chmod(target / pic.name, 0o600)
            if entry(pic) != entry(target / pic.name):
                raise OpsError('checksum da cópia não confere; interromper para inspeção')
        except FileExistsError as exc:
            raise OpsError('conflito concorrente durante migração; verificar destino') from exc
    print('MIGRATE_OK: copiados=' + str(len(to_copy)) + ', originais preservados')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    b = commands.add_parser('backup', help='Snapshot consistente após parada de escritas')
    b.add_argument('--db', required=True)
    b.add_argument('--uploads', required=True)
    b.add_argument('--output', required=True)
    b.add_argument('--quiesced', action='store_true', help='Confirma ausência de escritas')
    v = commands.add_parser('verify', help='Verifica digest SHA-256 e integridade SQLite')
    v.add_argument('--snapshot', required=True)
    r = commands.add_parser('restore', help='Restaura exclusivamente em destinos novos')
    r.add_argument('--snapshot', required=True)
    r.add_argument('--db', required=True)
    r.add_argument('--uploads', required=True)
    r.add_argument('--apply', action='store_true')
    r.add_argument('--quiesced', action='store_true')
    m = commands.add_parser('migrate-images', help='Copia legado sem apagar ou sobrescrever')
    m.add_argument('--source', required=True)
    m.add_argument('--target', required=True)
    m.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'backup':
            backup(args)
        elif args.action == 'verify':
            data = verify(absolute(args.snapshot, 'snapshot'))
            print('VERIFY_OK: SQLite e arquivos íntegros; arquivos=' + str(len(data['images'])))
        elif args.action == 'restore':
            restore(args)
        elif args.action == 'migrate-images':
            migrate_images(args)
    except (OpsError, OSError, sqlite3.Error) as error:
        # Avoid printing paths or file contents from exceptions in public CI logs.
        print('OPS_ERROR: ' + (str(error) if isinstance(error, OpsError) else 'falha de I/O ou SQLite'), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
