import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const systemPrompt = `Tu es un assistant islamique bienveillant. Tu expliques l'islam avec douceur, sagesse et respect. 
Tu cites toujours tes sources : versets du Coran (avec numéro de sourate et verset), hadiths authentiques (avec référence), 
ou avis de savants connus. Si tu ne connais pas la réponse, dis-le avec bienveillance. 
Tu t'exprimes comme un ami proche, rassurant et sincère. Et tu ne reponds a aucune question qui n'est pas islamique.`;

app.post('/api/gpt', async (req, res) => {
  try {
    const { message, context } = req.body;

    const messages = [
      { role: "system", content: systemPrompt }
    ];

    // Ajouter le contexte s'il existe
    if (context) {
      messages.push({ role: "system", content: `Contexte de la conversation précédente: ${context}` });
    }

    messages.push({ role: "user", content: message });

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      temperature: 0.7,
      max_tokens: 500
    });

    // Extraire le contexte mis à jour de la réponse
    const reply = completion.choices[0].message.content;
    const updatedContext = context ? `${context}\n${message}\n${reply}` : `${message}\n${reply}`;

    res.json({ 
      reply: reply,
      context: updatedContext
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Une erreur est survenue' });
  }
});

app.listen(port, () => {
  console.log(`Serveur démarré sur le port ${port}`);
}); 