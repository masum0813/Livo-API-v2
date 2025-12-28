export const logger = {
  debug(msg, meta) {
    try {
      const m = meta !== undefined ? ` ${JSON.stringify(meta)}` : "";
      console.log(`[${new Date().toISOString()}] [DEBUG] ${msg}${m}`);
    } catch (e) {
      console.log(`[${new Date().toISOString()}] [DEBUG] ${String(msg)}`);
    }
  },
  info(msg, meta) {
    try {
      const m = meta !== undefined ? ` ${JSON.stringify(meta)}` : "";
      console.log(`[${new Date().toISOString()}] [INFO] ${msg}${m}`);
    } catch (e) {
      console.log(`[${new Date().toISOString()}] [INFO] ${String(msg)}`);
    }
  },
  warn(msg, meta) {
    try {
      const m = meta !== undefined ? ` ${JSON.stringify(meta)}` : "";
      console.warn(`[${new Date().toISOString()}] [WARN] ${msg}${m}`);
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] [WARN] ${String(msg)}`);
    }
  },
  error(msg, meta) {
    try {
      const m = meta !== undefined ? ` ${JSON.stringify(meta)}` : "";
      console.error(`[${new Date().toISOString()}] [ERROR] ${msg}${m}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [ERROR] ${String(msg)}`);
    }
  },
};

export default logger;
