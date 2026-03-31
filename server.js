const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// Trust proxy
app.set('trust proxy', 1);

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

// Ensure directories exist
['uploads', 'outputs', 'library'].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(express.static('public'));

// Library endpoint - list all generated audio
app.get('/api/library', (req, res) => {
  try {
    const libraryDir = 'library';
    const files = fs.readdirSync(libraryDir);
    const metadata = [];

    files.forEach(file => {
      if (file.endsWith('.json')) {
        const metaPath = path.join(libraryDir, file);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        metadata.push(meta);
      }
    });

    // Sort by timestamp, newest first
    metadata.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(metadata);
  } catch (error) {
    console.error('Error reading library:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete audio from library
app.delete('/api/library/:id', (req, res) => {
  try {
    const { id } = req.params;
    const metaPath = path.join('library', `${id}.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    
    // Delete both metadata and audio file
    fs.unlinkSync(metaPath);
    fs.unlinkSync(path.join('outputs', meta.filename));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting audio:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Generate audio from text (with caching)
app.post('/api/text-to-audio', async (req, res) => {
  try {
    const { text, voice = 'Aria' } = req.body;
    const MAX_CHARS = 5000;
    
    if (!text || text.length === 0) {
      return res.status(400).json({ error: 'Text is empty' });
    }
    
    if (text.length > MAX_CHARS) {
      return res.status(413).json({ 
        error: `Text too long. Maximum: ${MAX_CHARS} characters` 
      });
    }
    
    if (!VOICES[voice]) {
      return res.status(400).json({ error: `Unknown voice: ${voice}` });
    }
    
    // Create hash of text + voice for caching
    const hash = crypto.createHash('sha256').update(text + voice).digest('hex').substring(0, 8);
    const metaPath = path.join('library', `${hash}.json`);
    
    // Check if already generated
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      return res.json(meta);
    }
    
    console.log(`Generating ${text.length} characters with voice ${voice}...`);
    
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
    
    // Save audio file
    const filename = `${hash}.mp3`;
    const outputPath = path.join('outputs', filename);
    fs.writeFileSync(outputPath, response.data);
    
    // Save metadata
    const metadata = {
      id: hash,
      filename: filename,
      voice: voice,
      text: text,
      textPreview: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
      size: response.data.length,
      timestamp: new Date().toISOString()
    };
    
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    
    res.json(metadata);
  } catch (error) {
    console.error('Error:', error.message);
    
    if (error.response?.status === 402) {
      return res.status(402).json({ error: 'ElevenLabs quota exceeded' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// File upload endpoint
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
