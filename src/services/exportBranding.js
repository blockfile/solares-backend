const fs = require("fs");
const path = require("path");

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function resolveLogoPath() {
  const configured = process.env.EXPORT_LOGO_PATH || process.env.SOLARES_LOGO_PATH;
  const candidates = [
    configured ? path.resolve(configured) : null,
    path.join(process.cwd(), "frontend", "public", "SOLARES.png"),
    path.join(process.cwd(), "..", "frontend", "public", "SOLARES.png"),
    path.join(__dirname, "../../../frontend/public/SOLARES.png"),
    path.join(__dirname, "../../../frontend/src/components/assets/SOLARES.png")
  ];

  return firstExisting(candidates);
}

function addLogoToWorksheet(workbook, worksheet, options = {}) {
  const logoPath = resolveLogoPath();
  if (!logoPath) return false;

  const {
    col = 0,
    row = 0,
    width = 64,
    height = 64
  } = options;

  const imageId = workbook.addImage({
    filename: logoPath,
    extension: "png"
  });

  worksheet.addImage(imageId, {
    tl: { col, row },
    ext: { width, height }
  });

  return true;
}

function drawLogoOnPdf(doc, options = {}) {
  const logoPath = resolveLogoPath();
  if (!logoPath) return false;

  const {
    x = 40,
    y = 40,
    width = 56,
    height = 56
  } = options;

  doc.image(logoPath, x, y, { fit: [width, height] });
  return true;
}

module.exports = {
  addLogoToWorksheet,
  drawLogoOnPdf,
  resolveLogoPath
};
