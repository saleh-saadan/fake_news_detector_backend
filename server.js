// ===== server.js (Node.js Backend) =====
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Helper function to run Python scripts
const runPythonScript = (scriptName, args) => {
  return new Promise((resolve, reject) => {
    const python = spawn('python', [
      path.join(__dirname, 'ai_models', scriptName),
      ...args
    ]);

    let dataString = '';
    let errorString = '';

    python.stdout.on('data', (data) => {
      dataString += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorString += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorString || 'Python script failed'));
      } else {
        try {
          const result = JSON.parse(dataString);
          resolve(result);
        } catch (e) {
          reject(new Error('Failed to parse Python output'));
        }
      }
    });
  });
};

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'AI Fake News & Deepfake Detector API' });
});

// Fake News Detection Endpoint
app.post('/api/analyze-news', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Run Python fake news detection
    const result = await runPythonScript('fake_news_detector.py', [text]);

    res.json(result);
  } catch (error) {
    console.error('Error analyzing news:', error);
    res.status(500).json({ error: 'Failed to analyze text' });
  }
});

// Deepfake Detection Endpoint
app.post('/api/analyze-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Video file is required' });
    }

    const videoPath = req.file.path;

    // Run Python deepfake detection
    const result = await runPythonScript('deepfake_detector.py', [videoPath]);

    // Clean up uploaded file
    fs.unlinkSync(videoPath);

    res.json(result);
  } catch (error) {
    console.error('Error analyzing video:', error);
    
    // Clean up file if exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({ error: 'Failed to analyze video' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});