const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Trust proxy
app.set('trust proxy', 1);

// Handle reverse proxy paths
app.use((req, res, next) => {
  // If we're behind a proxy with a path prefix, Express won't see it
  // The proxy should send X-Forwarded-Prefix or we extract from the original path
  next();
});

// Read API key from secure location
const API_KEY = fs.readFileSync('/root/.openclaw/workspace/.elevenlabs_key', 'utf-8').trim();
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// Voice mapping
const VOICES = {
  'Aria': '9BWtsMINqrJLrRacOk9x',
  'Bill': 'EZaLK7UNe3c6kp_4XDbd',
  'Callum': 'N2lVS1Nnvgma5dvaywzL',
  'Lily': 'piTKgcLEGmPLZcj7nXlC',
};

app.use(express.static('public'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Convert endpoint
app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    const { voice = 'Aria' } = req.body;
    const MAX_CHARS = 5000;
    const MAX_FILE_SIZE = 50 * 1024; // 50KB
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    if (req.file.size > MAX_FILE_SIZE) {
      fs.unlinkSync(req.file.path);
      return res.status(413).json({ error: `File too large. Maximum: ${MAX_FILE_SIZE / 1024}KB` });
    }
    
    if (!VOICES[voice]) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Unknown voice: ${voice}` });
    }
    
    // Read uploaded file
    const filePath = req.file.path;
    const text = fs.readFileSync(filePath, 'utf-8');
    
    if (!text || text.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'File is empty' });
    }
    
    if (text.length > MAX_CHARS) {
      fs.unlinkSync(filePath);
      return res.status(413).json({ 
        error: `Text too long. Maximum: ${MAX_CHARS} characters. Yours: ${text.length}` 
      });
    }
    
    console.log(`Converting ${text.length} characters with voice ${voice}...`);
    
    const voiceId = VOICES[voice];
    const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`;
    
    const response = await axios.post(url, {
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    }, {
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    });
    
    // Save to temp file
    const outputPath = path.join('outputs', `${Date.now()}.mp3`);
    if (!fs.existsSync('outputs')) {
      fs.mkdirSync('outputs', { recursive: true });
    }
    fs.writeFileSync(outputPath, response.data);
    
    // Clean up upload
    fs.unlinkSync(filePath);
    
    res.json({ 
      success: true, 
      file: outputPath,
      size: response.data.length,
      filename: `book_audio_${Date.now()}.mp3`
    });
  } catch (error) {
    console.error('Error:', error.message);
    if (req.file) fs.unlinkSync(req.file.path);
    
    if (error.response?.status === 402) {
      return res.status(402).json({ error: 'ElevenLabs quota exceeded or account not upgraded' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Download endpoint
app.get('/api/download/:file', (req, res) => {
  const filePath = path.join('outputs', req.params.file);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.download(filePath, `book_audio_${Date.now()}.mp3`, () => {
    // Optionally clean up after download
    // fs.unlinkSync(filePath);
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Book-to-audio server running on port ${PORT}`);
  console.log(`Visit https://134.209.176.228/audio in your browser`);
});
