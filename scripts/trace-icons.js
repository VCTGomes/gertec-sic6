// Converte PNGs de ícone (branco sobre transparente) em paths vetoriais (SVG)
// e gera um arquivo CSS que usa `mask` para colorir via background-color.
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const potrace = require('potrace');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'scripts', '_tmp');
fs.mkdirSync(TMP, { recursive: true });

const ICONS = [
  { name: 'buscapreco', src: path.join(ROOT, 'buscapreco.png') },
  { name: 'tc506',      src: path.join(ROOT, 'tc506.png') },
];

// Limiar de alfa: pixel "preenchido" se opacidade > este valor.
const ALPHA_THRESHOLD = 90;

function trace(file, opts) {
  return new Promise((resolve, reject) => {
    potrace.trace(file, opts, (err, svg) => (err ? reject(err) : resolve(svg)));
  });
}

(async () => {
  const results = [];

  for (const icon of ICONS) {
    const img = await Jimp.read(icon.src);
    const { width, height, data } = img.bitmap;

    // Achata o canal alfa: forma -> preto opaco, fundo -> branco opaco.
    // potrace traça regiões escuras sobre fundo claro.
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      const v = a > ALPHA_THRESHOLD ? 0 : 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }

    const bw = path.join(TMP, `${icon.name}-bw.png`);
    await img.write(bw);

    const svg = await trace(bw, {
      threshold: 128,
      turdSize: 30,        // descarta manchas minúsculas (ruído)
      optTolerance: 0.4,   // suaviza curvas de Bézier
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
    });

    // Extrai todos os atributos `d` dos paths gerados.
    const ds = [...svg.matchAll(/\bd="([^"]+)"/g)].map(m => m[1]);
    const d = ds.join(' ');
    results.push({ name: icon.name, width, height, d });
    console.log(`${icon.name}: ${ds.length} path(s), ${d.length} chars`);
  }

  // SVG -> data URI (URL-encoded, compatível com CSS mask).
  const svgUri = (w, h, d) => {
    // fill-rule evenodd preserva os "furos" (ex.: a tela do Busca Preço).
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><path fill-rule='evenodd' d='${d}'/></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg)
      .replace(/'/g, '%27').replace(/"/g, '%22');
  };

  let css = `/* Ícones de terminal vetorizados a partir de PNG (gerado por scripts/trace-icons.js).
   Uso: <span class="term-icon term-icon--tc506"></span>
   A cor é controlada por \`color\` / \`background-color\`; o desenho vem do mask. */
.term-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  background-color: currentColor;
  -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
  -webkit-mask-position: center;
          mask-position: center;
  -webkit-mask-size: contain;
          mask-size: contain;
  vertical-align: -0.125em;
}
`;

  for (const r of results) {
    const uri = svgUri(r.width, r.height, r.d);
    css += `.term-icon--${r.name} {
  -webkit-mask-image: url("${uri}");
          mask-image: url("${uri}");
}
`;
  }

  const out = path.join(ROOT, 'public', 'assets', 'css', 'term-icons.css');
  fs.writeFileSync(out, css);
  console.log('CSS escrito em', out, `(${css.length} bytes)`);
})().catch(e => { console.error(e); process.exit(1); });
