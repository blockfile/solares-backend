const fs = require("fs");
const path = require("path");
const multer = require("multer");
const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("../controllers/events.controller");

const uploadDir = path.resolve(process.cwd(), "uploads", "event-photos");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || "")).toLowerCase() || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${stamp}${safeExt}`);
  }
});

const photoUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(String(file.mimetype || ""))) {
      return cb(new Error("Only JPG, PNG, WEBP, or GIF images are allowed"));
    }
    return cb(null, true);
  }
});

function uploadReportPhoto(req, res, next) {
  photoUpload.single("photo")(req, res, (error) => {
    if (error) {
      return res.status(400).json({ message: error.message || "Failed to upload event photo" });
    }
    return next();
  });
}

router.get("/meta", auth, requireModule("calendar"), c.meta);
router.get("/", auth, requireModule("calendar"), c.list);
router.post("/", auth, requireModule("calendar"), c.create);
router.post("/:id/report", auth, requireModule("calendar"), uploadReportPhoto, c.submitReport);
router.put("/:id", auth, requireModule("calendar"), c.update);
router.delete("/:id", auth, requireModule("calendar"), c.remove);

module.exports = router;
