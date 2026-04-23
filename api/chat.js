// api/chat.js — Backend Pena de Ouro
// Integração com API real do Tecimob + recomendação via Anthropic

// ─── Distância entre coordenadas (Haversine) ──────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Normaliza um imóvel do formato Tecimob para o formato interno ────────────
function normalizarImovel(im) {
  const dormRoom = (im.rooms || []).find(r => r.name === "bedroom");
  const dorms = dormRoom ? dormRoom.value : 0;

  const precoStr = (im.price || "0").replace(/[R$\s.]/g, "").replace(",", ".");
  const preco = parseFloat(precoStr) || 0;

  const caracteristicas = (im.characteristics || []).map(c => c.title).slice(0, 5).join(", ");

  return {
    id:      im.id,
    titulo:  `${im.type || "Imóvel"} - ${im.street_address || ""}, ${im.street_number || ""}`.trim(),
    tipo:    im.type    || "Imóvel",
    dorms,
    preco,
    bairro:  im.neighborhood?.name       || "",
    cidade:  im.neighborhood?.city?.name || "Araçatuba",
    cep:     (im.zip_code || "").replace(/\D/g, ""),
    lat:     parseFloat(im.maps_latitude)  || null,
    lon:     parseFloat(im.maps_longitude) || null,
    desc:    caracteristicas || im.situation || "",
    url:     im.url || "",
    status:  im.status || "",
    financiavel: im.is_financeable ? "Financiável" : "",
  };
}

// ─── Busca todas as páginas do Tecimob (até 5 páginas = 100 imóveis) ──────────
async function buscarEstoqueTecimob() {
  const KEY  = process.env.TECIMOB_API_KEY;
  const BASE = "http://api.tecimob.com.br/api/properties";

  if (!KEY) throw new Error("TECIMOB_API_KEY não configurada.");

  let todos = [];
  let page  = 1;
  const MAX_PAGES = 5;

  while (page <= MAX_PAGES) {
    const resp = await fetch(`${BASE}?page=${page}`, {
      headers: {
        Authorization: `Bearer ${KEY}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Tecimob API erro ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const items = data.data || [];
    todos = todos.concat(items.map(normalizarImovel));

    if (!data.links?.next || items.length === 0) break;
    page++;
  }

  return todos;
}

// ─── Cache em memória (24h) ───────────────────────────────────────────────────
let _cache = { estoque: null, atualizadoEm: null };
const CACHE_MS = 24 * 60 * 60 * 1000;

async function buscarEstoqueComCache() {
  const agora = Date.now();
  const valido = _cache.estoque && _cache.atualizadoEm && (agora - _cache.atualizadoEm < CACHE_MS);
  if (valido) return _cache.estoque;
  const estoque = await buscarEstoqueTecimob();
  _cache = { estoque, atualizadoEm: agora };
  return estoque;
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { system, messages, originLat, originLon, raio } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Parâmetro 'messages' inválido." });
  }

  try {
    const estoque = await buscarEstoqueComCache();

    let imovelFiltrados = estoque;

    if (originLat && originLon && raio) {
      const raioKm = parseFloat(raio);
      imovelFiltrados = estoque
        .filter(im => im.lat && im.lon)
        .map(im => ({
          ...im,
          dist: Math.round(haversineKm(originLat, originLon, im.lat, im.lon) * 10) / 10
        }))
        .filter(im => im.dist <= raioKm)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 20);
    }

    const fmt = v => Number(v).toLocaleString("pt-BR", {
      style: "currency", currency: "BRL", maximumFractionDigits: 0
    });

    const estoqueStr = imovelFiltrados.length
      ? imovelFiltrados.map((im, i) =>
          `[${i}] ${im.titulo} — ${im.bairro}, ${im.cidade} — ${im.tipo}${im.dorms > 0 ? " " + im.dorms + " dorms" : ""} — ${fmt(im.preco)}${im.dist != null ? " — " + im.dist + "km" : ""}${im.financiavel ? " — " + im.financiavel : ""} — ${im.desc}`
        ).join("\n")
      : "Nenhum imóvel encontrado no raio informado. Sugira ao cliente ampliar o raio de busca.";

    const systemFinal = `${system || ""}

Estoque real da Pena de Ouro (${imovelFiltrados.length} imóveis encontrados via Tecimob):
${estoqueStr}`;

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemFinal,
        messages,
      }),
    });

    if (!anthropicResp.ok) {
      const err = await anthropicResp.text();
      return res.status(anthropicResp.status).json({ error: err });
    }

    const anthropicData = await anthropicResp.json();
    const content = anthropicData.content.map(c => c.text || "").join("");

    return res.status(200).json({ content, imoveis: imovelFiltrados });

  } catch (error) {
    console.error("Erro:", error.message);
    return res.status(500).json({ error: error.message || "Erro interno." });
  }
}
