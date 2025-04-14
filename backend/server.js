// server.js
const express = require("express");
const cors = require("cors");
const youtubedl = require("youtube-dl-exec");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

// Simple rate limiting implementation without external package
const requestCounts = {};
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // 10 requests per window

const simpleRateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  // Initialize or reset expired counters
  if (!requestCounts[ip] || Date.now() > requestCounts[ip].resetTime) {
    requestCounts[ip] = {
      count: 1,
      resetTime: Date.now() + RATE_LIMIT_WINDOW_MS
    };
    return next();
  }
  
  // Increment counter if within window
  if (requestCounts[ip].count < RATE_LIMIT_MAX) {
    requestCounts[ip].count++;
    return next();
  }
  
  // Rate limit exceeded
  return res.status(429).json({ error: "Too many requests, please try again later" });
};

// Detect the platform from the URL
function detectPlatform(url) {
  if (!url) return null;
  
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      return 'youtube';
    } else if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
      return 'twitter';
    } else if (hostname.includes('instagram.com')) {
      return 'instagram';
    } else if (hostname.includes('facebook.com') || hostname.includes('fb.com')) {
      return 'facebook';
    }
  } catch (e) {
    console.error("URL parsing error:", e);
  }
  
  return null;
}

// Get video info without downloading
app.get("/info", simpleRateLimiter, async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: "No video URL provided" });

  const platform = detectPlatform(videoUrl);
  if (!platform) return res.status(400).json({ error: "Unsupported platform" });

  try {
    const info = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      noWarnings: true,
      addHeader: ['referer:youtube.com', 'user-agent:googlebot']
    });

    // Handle platform-specific transformations
    let formats = [];
    
    if (platform === 'youtube') {
      formats = info.formats
        .filter(format => format.ext === 'mp4' && format.vcodec !== 'none' && format.acodec !== 'none')
        .map(format => ({
          formatId: format.format_id,
          quality: format.quality || 0,
          qualityLabel: format.quality_label || 'Unknown',
          resolution: format.resolution || 'Unknown',
          filesize: format.filesize || format.filesize_approx || 0
        }))
        .sort((a, b) => b.quality - a.quality);
    } else {
      // For non-YouTube platforms, we'll typically have fewer format options
      formats = info.formats
        .filter(format => format.ext === 'mp4' || format.ext === 'webm')
        .map(format => ({
          formatId: format.format_id,
          quality: format.quality || 0,
          qualityLabel: format.height ? `${format.height}p` : 'Unknown',
          resolution: format.resolution || `${format.width}x${format.height}` || 'Unknown',
          filesize: format.filesize || format.filesize_approx || 0
        }))
        .sort((a, b) => b.quality - a.quality);
    }

    // If no formats were found, provide a default
    if (formats.length === 0 && info.url) {
      formats = [{
        formatId: 'best',
        quality: 1,
        qualityLabel: 'Best available',
        resolution: 'Auto',
        filesize: 0
      }];
    }

    res.json({
      id: info.id || crypto.randomBytes(6).toString('hex'),
      title: info.title || `${platform} video`,
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      description: info.description?.substring(0, 200) + (info.description?.length > 200 ? '...' : '') || '',
      formats,
      platform
    });
  } catch (error) {
    console.error("Info error:", error);
    res.status(500).json({ error: `Failed to get video information: ${error.message}` });
  }
});

app.get("/download", simpleRateLimiter, async (req, res) => {
  const videoUrl = req.query.url;
  const formatId = req.query.format || 'best[ext=mp4]';
  
  if (!videoUrl) return res.status(400).json({ error: "No video URL provided" });

  const platform = detectPlatform(videoUrl);
  if (!platform) return res.status(400).json({ error: "Unsupported platform" });

  try {
    // Generate unique filename to handle concurrent downloads
    const fileId = crypto.randomBytes(8).toString('hex');
    const outputPath = path.join(DOWNLOAD_DIR, `${fileId}.mp4`);

    // Get video info first to get title for the filename
    const info = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true
    });

    // Sanitize the title for use as a filename
    const sanitizedTitle = (info.title || `${platform}_video`).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const outputFilename = `${sanitizedTitle}.mp4`;

    // Download the video with the selected format
    await youtubedl(videoUrl, {
      output: outputPath,
      format: formatId,
      noCheckCertificates: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:googlebot']
    });

    // Set content disposition with the sanitized title
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    // Stream the file to the client
    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    // Delete file after sending
    fileStream.on('end', () => {
      fs.unlink(outputPath, (err) => {
        if (err) console.error("Error deleting file:", err);
      });
    });

    fileStream.on('error', (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error streaming file" });
      }
    });
  } catch (error) {
    console.error("Download error:", error);
    
    // Provide more specific error messages
    if (error.message?.includes('Video unavailable')) {
      return res.status(400).json({ error: "Video is unavailable or private" });
    }
    
    if (error.message?.includes('This video is not available')) {
      return res.status(400).json({ error: "This video is not available or may be private" });
    }
    
    res.status(500).json({ error: `Failed to process video: ${error.message}` });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "An unexpected error occurred" });
});

// Clean up any leftover files in the downloads directory on startup
fs.readdir(DOWNLOAD_DIR, (err, files) => {
  if (err) {
    console.error("Error reading downloads directory:", err);
    return;
  }
  
  files.forEach(file => {
    fs.unlink(path.join(DOWNLOAD_DIR, file), err => {
      if (err) console.error(`Error deleting file ${file}:`, err);
    });
  });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));