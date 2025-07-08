import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Assurez-vous que votre clé API est définie dans un fichier .env
});

export default openai; 