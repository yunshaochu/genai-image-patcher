import http from 'node:http';
import https from 'node:https';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 前端读取远程图片时使用的同源代理路径。
 * 必须与 services/imageUtils.ts 里的 REMOTE_IMAGE_PROXY_PATH 保持一致。
 */
const IMAGE_PROXY_PATH = '/__remote-image';

/**
 * 上游「静默」超时（毫秒）：连续这么久**一个字节都没收到**才算超时。
 *
 * 以前是一个 20 秒的**总额**超时 —— ngrok 免费隧道传一张几 MB 的 PNG 经常要
 * 二十几秒，于是明明在正常下载也会被掐断（终端里那句 `upstream timeout
 * (20000ms)`）。现在只看「有没有进展」：数据还在来就一直等，收不到东西才认超时。
 */
const IMAGE_PROXY_IDLE_TIMEOUT = 30000;

/**
 * 单张图的总时长上限（毫秒）：兜住「每隔几秒滴几个字节」的死连接 —— 静默超时
 * 抓不到它，但也不能让它把请求永远占着。正常大小的图片远用不到这个数。
 */
const IMAGE_PROXY_MAX_TOTAL = 180000;

/** 上游失败时的重试次数（不含首次）。ngrok / 生图服务的瞬时抖动很常见。 */
const IMAGE_PROXY_RETRIES = 3;

/** 单张图片大小上限，防止误拉一个巨大文件把内存吃干。 */
const IMAGE_PROXY_MAX_BYTES = 64 * 1024 * 1024;

type UpstreamImage = { contentType: string; body: Buffer };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 用 node:http(s) 抓一张图。刻意 `agent: false`（每次新建连接）：
 * ngrok 会主动切断空闲连接，若复用 keep-alive 的 socket，会出现
 * 时好时坏的 ECONNRESET / socket hang up —— 这正是「成功率一半」的典型症状。
 */
const requestUpstreamImage = (target: URL): Promise<UpstreamImage> => {
  return new Promise<UpstreamImage>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    let req: http.ClientRequest | null = null;

    const clearTimers = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn();
    };

    /**
     * 每收到一点数据就重新计时：**只要还在下载就不中断**。
     * 只有连续 IMAGE_PROXY_IDLE_TIMEOUT 一个字节都没来（连接僵死 / ngrok 掉了）
     * 才判超时，交给外面的重试。
     */
    const armIdle = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => req?.destroy(new Error(`upstream stalled (${IMAGE_PROXY_IDLE_TIMEOUT}ms 内没有收到任何数据)`)),
        IMAGE_PROXY_IDLE_TIMEOUT
      );
    };

    const lib = target.protocol === 'https:' ? https : http;
    req = lib.request(
      target,
      {
        method: 'GET',
        agent: false,
        headers: {
          // ngrok 免费版：带上这个头才返回真实内容而不是 HTML 警告页。
          'ngrok-skip-browser-warning': 'true',
          'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          'User-Agent': 'bananaChange-image-proxy/1.0',
        },
      },
      (res) => {
        // 响应头到了 = 连接是活的（哪怕 body 还没开始传）。
        armIdle();
        const status = res.statusCode || 0;
        const contentType = String(res.headers['content-type'] || '');

        // 非 2xx 或不是图片（ngrok 警告页 / 登录页 / 上游错误页）→ 丢弃响应体，交给重试。
        if (status < 200 || status >= 300 || !contentType.toLowerCase().startsWith('image/')) {
          res.resume();
          settle(() => reject(new Error(`upstream ${status} (${contentType || 'no content-type'})`)));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          armIdle();
          total += chunk.length;
          if (total > IMAGE_PROXY_MAX_BYTES) {
            req?.destroy(new Error('upstream image too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => settle(() => resolve({ contentType, body: Buffer.concat(chunks) })));
        res.on('error', (error) => settle(() => reject(error)));
      }
    );

    req.on('error', (error) => settle(() => reject(error)));
    // 总时长兜底：数据一直在滴但永远传不完的连接也不能无限占着。
    totalTimer = setTimeout(
      () => req?.destroy(new Error(`upstream timeout (总时长超过 ${IMAGE_PROXY_MAX_TOTAL / 1000}s)`)),
      IMAGE_PROXY_MAX_TOTAL
    );
    armIdle();
    req.end();
  });
};

/** 带退避的重试包装：ngrok 抖动、上游 5xx、图片尚未落盘都能被吸收掉。 */
const requestUpstreamImageWithRetry = async (target: URL): Promise<UpstreamImage> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= IMAGE_PROXY_RETRIES; attempt++) {
    try {
      return await requestUpstreamImage(target);
    } catch (error) {
      lastError = error;
      if (attempt < IMAGE_PROXY_RETRIES) {
        await delay(250 * (attempt + 1) + Math.random() * 150);
      }
    }
  }
  throw lastError;
};

/**
 * 远程图片同源代理（dev / preview 服务器）。
 *
 * 生图接口（尤其是 ngrok 隧道后面的 `/v1/files/xxx.png`）通常不给
 * `Access-Control-Allow-Origin`，浏览器 `fetch` 会被 CORS 直接拦下；ngrok
 * 免费版还会把「浏览器请求」替换成 HTML 警告页（于是看到 `ERR_FAILED 200`）。
 *
 * 这里由 node 侧代跑 GET：
 *  - 补上 `ngrok-skip-browser-warning`，绕开 ngrok 的警告页；
 *  - 每次新建连接 + 失败退避重试，避免 ngrok 掐空闲连接导致的随机失败；
 *  - 校验上游 Content-Type 必须是 `image/*`，避免把警告页 HTML 当图片返回；
 *  - 附带 `Access-Control-Allow-Origin: *`，前端即可像同源资源一样读成 base64。
 *
 * 仅监听本机开发服务器，不做鉴权，只允许 http(s) 目标。
 */
const remoteImageProxy = (): Plugin => {
  const createMiddleware = (logger: { warn: (msg: string) => void }): Connect.NextHandleFunction => {
    return async (req, res) => {
      // connect 在带路由前缀注册时不会剥离 req.url，这里只解析 query，
      // 两种行为下都能拿到 url 参数。
      const rawUrl = req.url || '';
      const queryIndex = rawUrl.indexOf('?');
      const params = new URLSearchParams(queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '');
      const rawTarget = params.get('url');

      const fail = (status: number, message: string) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(message);
      };

      if (!rawTarget) return fail(400, 'missing "url" parameter');

      let target: URL;
      try {
        target = new URL(rawTarget);
      } catch {
        return fail(400, 'invalid "url" parameter');
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return fail(400, 'only http(s) targets are allowed');
      }

      try {
        const { contentType, body } = await requestUpstreamImageWithRetry(target);
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', String(body.length));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(body);
      } catch (error) {
        const message = (error as Error)?.message || String(error);
        // 打到 vite 终端，方便判断是 ngrok 抖动还是上游真的没有这张图。
        logger.warn(`[remote-image-proxy] ${target.href} 重试 ${IMAGE_PROXY_RETRIES} 次后仍失败：${message}`);
        return fail(502, message);
      }
    };
  };

  return {
    name: 'remote-image-proxy',
    configureServer(server) {
      server.middlewares.use(IMAGE_PROXY_PATH, createMiddleware(server.config.logger));
    },
    configurePreviewServer(server) {
      server.middlewares.use(IMAGE_PROXY_PATH, createMiddleware(server.config.logger));
    },
  };
};

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), tailwindcss(), remoteImageProxy()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve('.'),
        }
      }
    };
});
