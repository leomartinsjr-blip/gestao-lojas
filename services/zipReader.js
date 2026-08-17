// Leitor de .zip mínimo, só o suficiente para extrair os XMLs que o Microvix
// entrega. Feito sobre o zlib nativo para não trazer dependência nova.
//
// Suporta os dois métodos que aparecem na prática: 0 (armazenado) e 8 (deflate).

const zlib = require('zlib');

const FIM_DIRETORIO = 0x06054b50;
const ENTRADA_DIRETORIO = 0x02014b50;
const CABECALHO_LOCAL = 0x04034b50;

function _acharFimDoDiretorio(buf) {
  // O registro final tem tamanho variável por causa do comentário; varre de trás.
  const minimo = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minimo; i--) {
    if (buf.readUInt32LE(i) === FIM_DIRETORIO) return i;
  }
  return -1;
}

/**
 * Devolve [{ nome, conteudo: Buffer }] para cada arquivo do zip.
 * Diretórios e entradas vazias são ignorados.
 */
function lerZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const fim = _acharFimDoDiretorio(buf);
  if (fim === -1) throw new Error('Arquivo não parece ser um .zip válido');

  const qtd = buf.readUInt16LE(fim + 10);
  let pos = buf.readUInt32LE(fim + 16);

  const arquivos = [];
  for (let i = 0; i < qtd; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== ENTRADA_DIRETORIO) break;

    const metodo = buf.readUInt16LE(pos + 10);
    const tamComprimido = buf.readUInt32LE(pos + 20);
    const tamNome = buf.readUInt16LE(pos + 28);
    const tamExtra = buf.readUInt16LE(pos + 30);
    const tamComentario = buf.readUInt16LE(pos + 32);
    const offsetLocal = buf.readUInt32LE(pos + 42);
    const nome = buf.slice(pos + 46, pos + 46 + tamNome).toString('utf8');

    pos += 46 + tamNome + tamExtra + tamComentario;

    if (nome.endsWith('/')) continue;
    if (buf.readUInt32LE(offsetLocal) !== CABECALHO_LOCAL) continue;

    // O cabeçalho local repete nome e extra com tamanhos próprios.
    const tamNomeLocal = buf.readUInt16LE(offsetLocal + 26);
    const tamExtraLocal = buf.readUInt16LE(offsetLocal + 28);
    const inicio = offsetLocal + 30 + tamNomeLocal + tamExtraLocal;
    const bruto = buf.slice(inicio, inicio + tamComprimido);

    let conteudo;
    if (metodo === 0) conteudo = bruto;
    else if (metodo === 8) conteudo = zlib.inflateRawSync(bruto);
    else continue;

    arquivos.push({ nome, conteudo });
  }

  return arquivos;
}

/** Só os .xml, já convertidos para texto. */
function lerXmlsDoZip(buffer) {
  return lerZip(buffer)
    .filter(a => /\.xml$/i.test(a.nome))
    .map(a => ({ nome: a.nome, xml: a.conteudo.toString('utf8') }));
}

module.exports = { lerZip, lerXmlsDoZip };
