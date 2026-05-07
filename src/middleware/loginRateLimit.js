const rateLimit = require("express-rate-limit");

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const loginBurstLimiter = rateLimit({
  windowMs: toPositiveInteger(process.env.LOGIN_BURST_WINDOW_MS, 60_000),
  max: toPositiveInteger(process.env.LOGIN_BURST_LIMIT, 5),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Please wait and try again." }
});

const loginSustainedLimiter = rateLimit({
  windowMs: toPositiveInteger(process.env.LOGIN_RATE_WINDOW_MS, 15 * 60_000),
  max: toPositiveInteger(process.env.LOGIN_RATE_LIMIT, 20),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Please wait and try again." }
});

module.exports = [loginBurstLimiter, loginSustainedLimiter];
