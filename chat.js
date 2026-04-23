// api/chat.js — Backend seguro para o chat da Pena de Ouro
// Deploy no Vercel: a chave fica em variável de ambiente, nunca exposta ao visitante.

export default async function handler(req, res) {
  // Só aceita POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { system, messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Parâmetro 'messages' inválido." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,   // ← chave segura no servidor
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: system || "",
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const content = data.content.map(c => c.text || "").join("");

    return res.status(200).json({ content });

  } catch (error) {
    console.error("Erro na API Anthropic:", error);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
}
