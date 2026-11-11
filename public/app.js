const API_URL = window.location.origin;
const urlParams = new URLSearchParams(window.location.search);
const tokenAtual = urlParams.get('token');

const turmaTituloEl = document.getElementById('turma-titulo');
const secGeralEl = document.getElementById('sec-geral');
const secTurmaEl = document.getElementById('sec-turma');

async function carregarPublicacoes() {
    if (!tokenAtual) {
        exibirAcessoNegado("Acesso Restrito", "Utilize o Link Mágico fornecido pela creche para visualizar o mural da sua turma.");
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/publicacoes/token/${encodeURIComponent(tokenAtual)}`);
        
        if (!response.ok) {
            throw new Error('Link inválido ou expirado');
        }

        const data = await response.json();
        
        if (turmaTituloEl) {
            turmaTituloEl.textContent = `Turma: ${data.nome_turma.toUpperCase()}`;
        }

        renderizarMural(data.publicacoes, data.nome_turma);
    } catch (error) {
        console.error('Falha ao carregar publicações:', error);
        exibirAcessoNegado("Link Inválido ou Expirado", "Não foi possível carregar as informações desta turma. Verifique se o link está correto.");
    }
}

function exibirAcessoNegado(titulo, mensagem) {
    const blocoErro = `
        <div class="bg-amber-50 text-amber-800 p-6 rounded-2xl text-center text-sm shadow-sm border border-amber-200 my-4">
            <p class="font-bold text-base mb-1">${titulo}</p>
            <p>${mensagem}</p>
        </div>
    `;
    if (secGeralEl) secGeralEl.innerHTML = blocoErro;
    if (secTurmaEl) secTurmaEl.innerHTML = '';
}

function renderizarMural(publicacoes, nomeTurma) {
    // CORREÇÃO APLICADA: Limpa os containers antes de renderizar para não duplicar itens
    if (secGeralEl) secGeralEl.innerHTML = '';
    if (secTurmaEl) secTurmaEl.innerHTML = '';

    if (!publicacoes || publicacoes.length === 0) {
        if (secGeralEl) secGeralEl.innerHTML = '<div class="bg-white p-6 rounded-2xl text-center text-gray-500 shadow-sm border border-gray-100">Nenhuma publicação geral encontrada no momento.</div>';
        if (secTurmaEl) secTurmaEl.innerHTML = `<div class="bg-white p-6 rounded-2xl text-center text-gray-500 shadow-sm border border-gray-100">Nenhum aviso específico para a turma ${nomeTurma.toUpperCase()}.</div>`;
        return;
    }

    let htmlGeral = '';
    let htmlTurma = '';

    publicacoes.forEach(pub => {
        const dataFormatada = formatarData(pub.data);
        const imagemTag = pub.imagem_url 
            ? `<div class="h-48 bg-gray-200 relative overflow-hidden">
                 <img src="${pub.imagem_url}" alt="${pub.titulo}" class="w-full h-full object-cover">
                 <span class="absolute top-3 left-3 bg-[#f07167] text-white text-xs font-bold px-2.5 py-1 rounded-full shadow-md">${pub.tipo}</span>
               </div>`
            : '';

        if (pub.nome_turma && pub.nome_turma.toLowerCase() === 'geral') {
            htmlGeral += `
                <article class="bg-white rounded-2xl shadow-sm overflow-hidden border border-gray-100 mb-4">
                    ${imagemTag}
                    <div class="p-4">
                        <div class="flex justify-between items-start mb-2">
                            <span class="bg-red-50 text-[#b83b43] text-xs font-bold px-2 py-1 rounded-full">${pub.tipo}</span>
                            <p class="text-xs text-gray-400 font-medium">${dataFormatada}</p>
                        </div>
                        <h2 class="font-bold text-lg mb-1 text-gray-800">${pub.titulo}</h2>
                        <p class="text-sm text-gray-600 whitespace-pre-line">${pub.descricao || ''}</p>
                    </div>
                </article>
            `;
        } else {
            htmlTurma += `
                <article class="bg-white rounded-2xl shadow-sm overflow-hidden border border-gray-100 p-4 mb-4">
                    <div class="flex justify-between items-start mb-2">
                        <span class="bg-amber-100 text-amber-800 text-xs font-bold px-2 py-1 rounded-full">${pub.tipo}</span>
                        <p class="text-xs text-gray-400 font-medium">${dataFormatada}</p>
                    </div>
                    <h2 class="font-bold text-lg mb-2 text-[#b83b43]">${pub.titulo}</h2>
                    <p class="text-sm text-gray-600 whitespace-pre-line">${pub.descricao || ''}</p>
                    ${pub.imagem_url ? `<img src="${pub.imagem_url}" class="mt-3 rounded-xl w-full object-cover max-h-48">` : ''}
                </article>
            `;
        }
    });

    if (secGeralEl) secGeralEl.innerHTML = htmlGeral || `<p class="text-center text-gray-400 text-sm py-4">Sem avisos gerais cadastrados.</p>`;
    if (secTurmaEl) secTurmaEl.innerHTML = htmlTurma || `<p class="text-center text-gray-400 text-sm py-4">Sem avisos específicos para a turma ${nomeTurma.toUpperCase()}.</p>`;
}

function formatarData(dataString) {
    if (!dataString) return '';
    const partes = dataString.split('-');
    if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;
    return dataString;
}

function copiarPix() {
    const pixKey = document.getElementById('pix-key')?.textContent || '';
    navigator.clipboard.writeText(pixKey).then(() => {
        const toast = document.getElementById('toast');
        if (toast) {
            toast.classList.remove('opacity-0', 'pointer-events-none');
            setTimeout(() => {
                toast.classList.add('opacity-0', 'pointer-events-none');
            }, 3000);
        }
    });
}

document.addEventListener('DOMContentLoaded', carregarPublicacoes);