// api/chat.js — Backend Pena de Ouro
// Busca estoque via API Tecimob (cache 24h) + recomendação via Anthropic

// ─── Utilitário: distância entre coordenadas ──────────────────────────────────
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

// ─── Busca estoque no Tecimob ─────────────────────────────────────────────────
async function buscarEstoqueTecimob() {
  const TECIMOB_API_KEY = process.env.TECIMOB_API_KEY;
  const TECIMOB_BASE_URL = process.env.TECIMOB_BASE_URL; // Ex: https://api.tecimob.com.br/v1

  if (!TECIMOB_API_KEY || !TECIMOB_BASE_URL) {
    throw new Error("Variáveis TECIMOB_API_KEY e TECIMOB_BASE_URL não configuradas.");
  }

  const response = await fetch(
    `${TECIMOB_BASE_URL}/properties?status=active&limit=50&page=1`,
    {
      headers: {
        Authorization: `Bearer ${TECIMOB_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Tecimob API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  // Normaliza os campos para o padrão interno do app.
  // Ajuste os nomes abaixo conforme o JSON real retornado pelo Tecimob.
  const imoveis = (data.data || data.properties || data || []).map((im) => ({
    id:     im.id,
    titulo: im.title     || im.name  || `Imóvel ${im.id}`,
    tipo:   im.type      || "Imóvel",
    dorms:  im.bedrooms  ?? im.dorms ?? 0,
    preco:  parseFloat(im.sale_price || im.price || 0),
    cep:    (im.address?.zip_code || im.address?.cep || "").replace(/\D/g, ""),
    bairro: im.address?.neighborhood || im.neighborhood || "",
    cidade: im.address?.city || "",
    desc:   (im.short_description || im.description || "").replace(/<[^>]*>/g, "").slice(0, 120),
    lat:    parseFloat(im.latitude  || im.lat || 0) || null,
    lon:    parseFloat(im.longitude || im.lng || 0) || null,
  }));

  return imoveis;
}

// ─── Cache em memória (24h) ───────────────────────────────────────────────────
let _cache = { estoque: null, atualizadoEm: null };
const CACHE_MS = 24 * 60 * 60 * 1000;

async function buscarEstoqueComCache() {
  const agora = Date.now();
  const cacheValido =
    _cache.estoque &&
    _cache.atualizadoEm &&
    agora - _cache.atualizadoEm < CACHE_MS;

  if (cacheValido) {
    console.log("Usando cache do estoque.");
    return _cache.estoque;
  }

  console.log("Cache expirado — buscando Tecimob...");
  const estoque = await buscarEstoqueTecimob();
  _cache = { estoque, atualizadoEm: agora };
  return estoque;
}

// ─── Geocodifica um CEP via ViaCEP + Nominatim ────────────────────────────────
async function geocodeCep(cep) {
  const clean = cep.replace(/\D/g, "");
  if (clean.length !== 8) return null;

  try {
    const via = await fetch(`https://viacep.com.br/ws/${clean}/json/`).then((r) => r.json());
    if (via.erro) return null;

    const q = encodeURIComponent(
      `${via.logradouro || ""} ${via.bairro} ${via.localidade} ${via.uf} Brasil`
    );
    const nom = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`,
      { headers: { "Accept-Language": "pt-BR", "User-Agent": "PenaDeOuroApp/1.0" } }
    ).then((r) => r.json());

    if (!nom.length) return null;
    return { lat: parseFloat(nom[0].lat), lon: parseFloat(nom[0].lon) };
  } catch {
    return null;
  }
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
    // 1. Busca estoque com cache de 24h
    const estoque = await buscarEstoqueComCache();

    // 2. Filtra por proximidade geográfica se a origem foi enviada
    let imovelFiltrados = estoque;

    if (originLat && originLon && raio) {
      const raioKm = parseFloat(raio);

      const comCoord = await Promise.all(
        estoque.map(async (im) => {
          if (im.lat && im.lon) {
            const dist = Math.round(haversineKm(originLat, originLon, im.lat, im.lon) * 10) / 10;
            return { ...im, dist };
          }
          if (im.cep) {
            const coord = await geocodeCep(im.cep);
            if (coord) {
              const dist = Math.round(haversineKm(originLat, originLon, coord.lat, coord.lon) * 10) / 10;
              return { ...im, ...coord, dist };
            }
          }
          return { ...im, dist: 999 };
        })
      );

      imovelFiltrados = comCoord
        .filter((im) => im.dist <= raioKm)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 20);
    }

    // 3. Monta prompt com estoque real injetado
    const fmt = (v) =>
      Number(v).toLocaleString("pt-BR", {
        style: "currency", currency: "BRL", maximumFractionDigits: 0,
      });

    const estoqueStr = imovelFiltrados.length
      ? imovelFiltrados
          .map((im, i) =>
            `[${i}] ${im.titulo} — ${im.bairro}${im.cidade ? ", " + im.cidade : ""} — ${im.tipo}${im.dorms > 0 ? " " + im.dorms + " dorms" : ""} — ${fmt(im.preco)}${im.dist != null && im.dist < 999 ? " — " + im.dist + "km" : ""} — ${im.desc}`
          )
          .join("\n")
      : "Nenhum imóvel disponível no filtro atual.";

    const systemFinal = `${system || ""}

Estoque real da Pena de Ouro (atualizado via Tecimob):
${estoqueStr}`;

    // 4. Chama a Anthropic com o estoque injetado no contexto
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
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

    if (!anthropicResponse.ok) {
      const err = await anthropicResponse.text();
      return res.status(anthropicResponse.status).json({ error: err });
    }

    const anthropicData = await anthropicResponse.json();
    const content = anthropicData.content.map((c) => c.text || "").join("");

    // 5. Retorna resposta da IA + imóveis filtrados para o frontend renderizar
    return res.status(200).json({
      content,
      imoveis: imovelFiltrados,
    });

  } catch (error) {
    console.error("Erro no handler:", error.message);
    return res.status(500).json({ error: error.message || "Erro interno do servidor." });
  }
}
