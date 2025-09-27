require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const models = await genAI.getGenerativeModel({ model: 'gemini-pro' }).listModels();
    
    console.log('Available models:');
    for await (const m of models) {
      if (m.supportedGenerationMethods.includes('generateContent')) {
        console.log(m.name);
      }
    }
  } catch (error) {
    console.error('Error listing models:', error);
  }
}

listModels();
