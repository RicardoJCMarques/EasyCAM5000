// fiveserver.config.js with .htaccess emulation
const fs = require('fs');
const path = require('path');

module.exports = {
  port: 5500,

  middleware: [
    (req, res, next) => {
      const [pathname, search] = req.url.split('?');
      const query = search ? `?${search}` : '';
      const localPath = path.join(__dirname, decodeURIComponent(pathname));

      // CLEAN INDEX.HTML -> /
      if (pathname.endsWith('/index.html')) {
        const target = pathname.slice(0, -10) || '/';
        res.writeHead(301, { Location: target + query });
        return res.end();
      }

      // ENSURE DIRECTORY SLASH (DirectorySlash On)
      try {
        if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
          if (!pathname.endsWith('/')) {
            res.writeHead(301, { Location: pathname + '/' + query });
            return res.end();
          }
        }
      } catch {
        // Pass through on FS check failure
      }

      // STRIP .HTML EXTENSION
      if (pathname.endsWith('.html')) {
        res.writeHead(301, { Location: pathname.slice(0, -5) + query });
        return res.end();
      }

      // INTERNAL REWRITE (clean URL -> .html file)
      if (!pathname.endsWith('/')) {
        const htmlPath = localPath + '.html';
        try {
          if (fs.existsSync(htmlPath) && fs.statSync(htmlPath).isFile()) {
            req.url = pathname + '.html' + query;
          }
        } catch {
          // Pass through
        }
      }

      // MIME TYPE ENFORCEMENT
      const lower = req.url.toLowerCase();
      if (lower.endsWith('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
      } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'text/javascript');
      } else if (lower.endsWith('.json') || lower.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/json');
      } else if (lower.endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml');
      }

      // SECURITY HEADERS
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      next();
    }
  ]
};