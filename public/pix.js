'use strict';

// Apenas divulgação pública autorizada: nenhum serviço de pagamento ou API.
(() => {
    const CHAVE_PIX = '83.526.640/0001-67';
    let temporizador = null;

    function iniciarPix() {
        const chave = document.getElementById('pix-chave');
        const copiar = document.getElementById('btn-copiar-pix');
        const selecionar = document.getElementById('btn-selecionar-pix');
        const ajuda = document.getElementById('pix-ajuda-manual');
        const aviso = document.getElementById('pix-notificacao');
        const mensagem = document.getElementById('pix-aviso-mensagem');
        const icone = document.getElementById('pix-aviso-icone');
        const fechar = document.getElementById('pix-aviso-fechar');

        if (!chave || !copiar || !selecionar || !ajuda ||
            !aviso || !mensagem || !icone || !fechar) return;

        function ocultarAviso() {
            window.clearTimeout(temporizador);
            aviso.hidden = true;
        }
        function notificar(texto, sucesso) {
            ocultarAviso();
            aviso.setAttribute('role', sucesso ? 'status' : 'alert');
            aviso.setAttribute('aria-live', sucesso ? 'polite' : 'assertive');
            aviso.dataset.estado = sucesso ? 'sucesso' : 'erro';
            icone.textContent = sucesso ? '✓' : '!';
            mensagem.textContent = texto;
            aviso.hidden = false;
            temporizador = window.setTimeout(ocultarAviso, 4500);
        }
        function selecionarParaCopiaManual() {
            ajuda.hidden = false;
            chave.focus({ preventScroll: true });
            // Facilita Ctrl+C ou a opção nativa "Copiar"; nunca afirma ter copiado.
            try {
                const intervalo = document.createRange();
                const selecao = window.getSelection();
                if (selecao) {
                    intervalo.selectNodeContents(chave);
                    selecao.removeAllRanges();
                    selecao.addRange(intervalo);
                }
            } catch {
                // O texto permanece selecionável por toque longo mesmo sem Range API.
            }
        }

        copiar.addEventListener('click', async () => {
            if (copiar.disabled) return;
            copiar.disabled = true;
            ocultarAviso(); // Uma confirmação antiga não vale para a nova tentativa.
            try {
                if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                    throw new Error('Clipboard API indisponível');
                }
                await navigator.clipboard.writeText(CHAVE_PIX);
                notificar('Chave PIX copiada com sucesso!', true);
            } catch {
                selecionarParaCopiaManual();
                notificar('Não foi possível copiar automaticamente. Selecione a chave e copie manualmente.', false);
            } finally {
                copiar.disabled = false;
            }
        });
        selecionar.addEventListener('click', selecionarParaCopiaManual);
        fechar.addEventListener('click', ocultarAviso);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciarPix);
    } else {
        iniciarPix();
    }
})();
