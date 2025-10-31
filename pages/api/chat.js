export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get API key from environment variable
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: message
          }]
        }]
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Gemini API error: ${response.status} ${text}`);
    }

    const data = await response.json();

    // Defensive checks for response shape
    const responseText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ??
      data?.candidates?.[0]?.output ??
      null;

    if (!responseText) {
      throw new Error('Unexpected Gemini response format');
    }

    res.status(200).json({
      success: true,
      response: responseText
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: 'Failed to process request',
      details: error?.message ?? String(error)
    });
  }
}