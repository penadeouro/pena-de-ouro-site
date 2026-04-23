export default async function handler(req, res) {
  const response = await fetch(
    "https://api.tecimob.com.br/v1/properties?status=active&limit=2",
    {
      headers: {
        Authorization: `Bearer ${process.env.TECIMOB_API_KEY}`,
        Accept: "application/json",
      },
    }
  );
  const data = await response.json();
  return res.status(200).json(data);
}
