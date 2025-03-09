const express = require("express");
const cors = require("cors");
const youtubedl = require("youtube-dl-exec");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

app.get("/download", async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: "No video URL provided" });

  try {
    const outputPath = path.join(DOWNLOAD_DIR, "video.mp4");

    await youtubedl(videoUrl, {
      output: outputPath,
      format: "mp4",
    });

    res.download(outputPath, "downloaded-video.mp4", () => {
      fs.unlinkSync(outputPath); // Delete file after sending
    });
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({ error: "Failed to process video" });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
