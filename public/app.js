'use strict';

const API_URL = window.location.origin;
const tokenAtual = new URLSearchParams(window.location.search).get('token');
const secGeralEl = document.getElementById('sec-geral');
const conteudoTurmaEl = document.getElementById('conteudo-turma');
const turmaTituloEl = document.getElementById('turma-titulo');
const headerTurmaEl = document.getElementById('header-turma');

function textoElemento(tag, classes, conteudo) {
    const elemento = document.createElement(tag);
    elemento.className = classes;
    elemento.textContent = conteudo == null ? '' : String(conteudo);
    return elemento;
}

// Apenas URLs públicas de imagens geradas pela aplicação: nunca aceitar javascript:, data:,
// protocolo externo, parâmetros ou navegação por diretórios.
function imagemPublicadaSegura(url) {
    return typeof url === 'string' &&
        /^\/uploads\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|gif|webp|avif)$/.test(url)
        ? url : null;
}

function formatarData(data) {
    if (typeof data !== 'string') return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
    return match ? match[3] + '/' + match[2] + '/' + match[1] : data;
}

function mensagemEstado(container, titulo, mensagem) {
    if (!container) return;
    const bloco = document.createElement('div');
    bloco.className = 'bg-white rounded-2xl border border-gray-100 p-5 text-center shadow-sm';
    bloco.appendChild(textoElemento('p', 'font-bold text-gray-700 mb-1', titulo));
    if (mensagem) bloco.appendChild(textoElemento('p', 'text-sm text-gray-500', mensagem));
    container.replaceChildren(bloco);
}

function exibirAcessoNegado(titulo, mensagem) {
    mensagemEstado(secGeralEl, titulo, mensagem);
    mensagemEstado(conteudoTurmaEl, 'Mural da turma indisponível', mensagem);
    if (headerTurmaEl) headerTurmaEl.textContent = 'Acesso por link de turma';
    if (turmaTituloEl) turmaTituloEl.textContent = 'Turma não identificada';
}

function criarCartaoPublicacao(pub, geral) {
    const artigo = document.createElement('article');
    artigo.className = 'bg-white rounded-2xl shadow-sm overflow-hidden border border-gray-100';
    const imagemUrl = imagemPublicadaSegura(pub.imagem_url);
    if (imagemUrl) {
        const imagem = document.createElement('img');
        imagem.src = imagemUrl;
        imagem.alt = pub.titulo ? 'Imagem: ' + String(pub.titulo) : 'Imagem da publicação';
        imagem.loading = 'lazy';
        imagem.decoding = 'async';
        // Mantém proporção e a fotografia inteira, sem altura fixa/corte por cover.
        // A própria imagem determina a altura do cartão até o limite responsivo.
        imagem.className = 'block mx-auto object-contain';
        imagem.style.width = 'auto';
        imagem.style.height = 'auto';
        imagem.style.maxWidth = '100%';
        imagem.style.maxHeight = 'min(56vh, 26rem)';
        imagem.addEventListener('error', () => {
            // Uma URL inexistente não deixa ícone de imagem quebrada no mural.
            imagem.remove();
        }, { once: true });
        artigo.appendChild(imagem);
    }

    const conteudo = document.createElement('div');
    conteudo.className = 'p-4';
    const linha = document.createElement('div');
    linha.className = 'flex justify-between items-start gap-2 mb-2';
    linha.appendChild(textoElemento('span',
        geral ? 'bg-red-50 text-[#b83b43] text-xs font-bold px-2 py-1 rounded-full'
            : 'bg-amber-100 text-amber-800 text-xs font-bold px-2 py-1 rounded-full',
        pub.tipo));
    linha.appendChild(textoElemento('time', 'text-xs text-gray-400 font-medium', formatarData(pub.data)));
    conteudo.appendChild(linha);
    conteudo.appendChild(textoElemento('h2', 'font-bold text-lg mb-2 text-gray-800', pub.titulo));
    conteudo.appendChild(textoElemento('p', 'text-sm text-gray-600 whitespace-pre-line', pub.descricao || ''));
    artigo.appendChild(conteudo);
    return artigo;
}

function renderizarMural(publicacoes, nomeTurma) {
    if (!Array.isArray(publicacoes)) throw new Error('Resposta inválida de publicações.');
    const gerais = publicacoes.filter(pub => pub && pub.turma_id === null);
    // A autorização da turma é verificada pelo servidor a partir do token.
    const especificas = publicacoes.filter(pub => pub && Number.isInteger(pub.turma_id) && pub.turma_id > 0);

    if (secGeralEl) {
        secGeralEl.replaceChildren();
        if (gerais.length === 0) {
            mensagemEstado(secGeralEl, 'Nenhuma publicação geral no momento.');
        } else {
            gerais.forEach(pub => secGeralEl.appendChild(criarCartaoPublicacao(pub, true)));
        }
    }
    if (conteudoTurmaEl) {
        conteudoTurmaEl.replaceChildren();
        if (especificas.length === 0) {
            mensagemEstado(conteudoTurmaEl, 'Nenhuma publicação específica no momento.',
                'Turma: ' + nomeTurma);
        } else {
            especificas.forEach(pub => conteudoTurmaEl.appendChild(criarCartaoPublicacao(pub, false)));
        }
    }
}

async function carregarPublicacoes() {
    if (!tokenAtual) {
        exibirAcessoNegado('Link de turma necessário',
            'Use o link fornecido pela creche para ver as publicações. A área Apoie está disponível sem link.');
        return;
    }
    try {
        const response = await fetch(API_URL + '/api/publicacoes/token/' + encodeURIComponent(tokenAtual), {
            cache: 'no-store'
        });
        if (!response.ok) {
            if (response.status === 404) throw new Error('Link de turma inválido ou expirado.');
            throw new Error('Não foi possível consultar o mural agora.');
        }
        const data = await response.json();
        if (!data || typeof data.nome_turma !== 'string' || !Array.isArray(data.publicacoes)) {
            throw new Error('Resposta inválida do servidor.');
        }
        if (headerTurmaEl) headerTurmaEl.textContent = 'Turma: ' + data.nome_turma;
        if (turmaTituloEl) turmaTituloEl.textContent = 'Turma: ' + data.nome_turma;
        renderizarMural(data.publicacoes, data.nome_turma);
    } catch (erro) {
        exibirAcessoNegado('Mural indisponível', erro.message);
    }
}

document.addEventListener('DOMContentLoaded', carregarPublicacoes);
