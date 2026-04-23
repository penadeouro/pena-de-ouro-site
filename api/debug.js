export default async function handler(req, res) {
  try {
    const KEY = process.env.TECIMOB_API_KEY;
    
    if (!KEY) return res.status(200).json({ erro: "TECIMOB_API_KEY não encontrada nas variáveis de ambiente" });

    const response = await fetch("http://api.tecimob.com.br/api/properties?page=1", {
      headers: {
        Authorization: `Bearer ${KEY}`,
        Accept: "application/json",
      },
    });

    const text = await response.text();
    return res.status(200).json({ 
      status: response.status,
      primeiros_200_chars: text.slice(0, 200)
    });

  } catch (error) {
    return res.status(200).json({ erro: error.message });
  }
}
