const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
require('dotenv').config(); // Load .env variables

const app = express();
app.use(express.json()); // Replaces body-parser

// Load system prompt
const promptPath = path.resolve(__dirname, './systemPrompt.txt');
const systemPrompt = fs.readFileSync(promptPath, 'utf-8');

// Validate environment variables
const { VERIFY_TOKEN, PAGE_ACCESS_TOKEN, GEMINI_API_KEY } = process.env;
if (!VERIFY_TOKEN || !PAGE_ACCESS_TOKEN || !GEMINI_API_KEY) {
  throw new Error('Missing required environment variables in .env');
}

// In-memory session store
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Periodic session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.last_active > SESSION_TIMEOUT) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000); // Every 10 minutes

// Root route
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Facebook webhook verification
app.get('/facebook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden: This endpoint is for Facebook webhook verification only.');
  }
});

// Facebook webhook messages
app.post('/facebook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging?.[0];
      const senderId = webhookEvent?.sender?.id;

      if (webhookEvent?.message?.text && senderId) {
        const userMessage = webhookEvent.message.text;

        // Session handling
        let session = sessions.get(senderId);
        const currentTime = Date.now();
        if (!session || currentTime - session.last_active > SESSION_TIMEOUT) {
          session = { history: [], last_active: currentTime };
          sessions.set(senderId, session);
        } else {
          session.last_active = currentTime;
        }
        session.history.push({ role: 'user', parts: [{ text: userMessage }] });

        try {
          // Gemini API call
          const geminiResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
            {
              contents: session.history,
              systemInstruction: { parts: [{ text: systemPrompt }] },
              generationConfig: { maxOutputTokens: 200 }
            },
            { headers: { 'Content-Type': 'application/json' } }
          );

          const reply = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text 
                        || 'Sorry, I couldn’t generate a response.';
          session.history.push({ role: 'model', parts: [{ text: reply }] });

          // Send reply to Messenger
          await axios.post(
            `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            { recipient: { id: senderId }, message: { text: reply } }
          );
        } catch (error) {
          console.error('Gemini or Messenger API error:', error.response?.data || error.message);
          await axios.post(
            `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            { recipient: { id: senderId }, message: { text: 'Oops! Something went wrong.' } }
          );
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Export for Vercel serverless
module.exports = app;
