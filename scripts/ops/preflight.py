#!/usr/bin/env python3
"""Read-only filesystem preflight for the unprivileged Mural service account.

Must be executed as the SAME account used in systemd, not as root.
"""
import argparse
import os
from pathlib import Path
import stat
import sys


def fail(message):
    print('PREFLIGHT_ERROR: ' + message, file=sys.stderr)
    return 2


def symlinks(p):
    return any(x.is_symlink() for x in (p, *p.parents))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', required=True)
    parser.add_argument('--db', required=True)
    parser.add_argument('--uploads', required=True)
    parser.add_argument('--allow-new-db', action='store_true', help='Use apenas para instalação nova sem banco legado')
    a = parser.parse_args()
    paths = [Path(a.checkout), Path(a.db), Path(a.uploads)]
    if not all(x.is_absolute() for x in paths):
        return fail('todos os caminhos devem ser absolutos')
    repo, db, uploads = paths
    if not repo.is_dir() or symlinks(db) or symlinks(uploads):
        return fail('checkout inválido ou dados atravessam link simbólico')
    if not db.parent.is_dir() or not uploads.is_dir():
        return fail('diretório SQLite ou uploads ausente')
    repo_real = repo.resolve(strict=True)
    for name, candidate in [('SQLite', db), ('uploads', uploads)]:
        candidate_real = candidate.resolve(strict=False)
        if candidate_real == repo_real or repo_real in candidate_real.parents:
            return fail(name + ' não pode ficar dentro do checkout')
    if not os.access(db.parent, os.W_OK | os.X_OK):
        return fail('usuário sem escrita no diretório SQLite')
    if not os.access(uploads, os.R_OK | os.W_OK | os.X_OK):
        return fail('usuário sem leitura/escrita em uploads')
    if stat.S_IMODE(uploads.stat().st_mode) & 0o077:
        return fail('uploads deve negar acesso a grupo/outros (0700)')
    if db.exists():
        if not db.is_file() or (stat.S_IMODE(db.stat().st_mode) & 0o077):
            return fail('SQLite não é regular ou tem acesso aberto a grupo/outros')
        if not os.access(db, os.R_OK | os.W_OK):
            return fail('usuário sem leitura/escrita no SQLite')
    elif not a.allow_new_db:
        return fail('SQLite ausente: não criar banco vazio por acidente')
    print('PREFLIGHT_OK: caminhos externos, sem symlinks, permissões básicas aprovadas')
    return 0


if __name__ == '__main__':
    sys.exit(main())
