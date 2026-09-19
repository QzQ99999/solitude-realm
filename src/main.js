import './styles.css';
import { Game } from './game.js';
import { audio } from './audio.js';

const canvas = document.getElementById('app');

function boot() {
  audio.loadBank(); // 抢在场景装载期间抓取/解码音效采样（失败自动回退合成）
  try {
    const game = new Game(canvas);
    window.game = game; // 控制台可触达，方便把玩

    let last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      // 限制步长：切后台回来不会"瞬移"
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      try {
        game.frame(dt);
      } catch (error) {
        const dbg = document.getElementById('dbg');
        if (dbg) {
          dbg.style.color = '#ff8a7a';
          dbg.textContent = 'ERR ' + (error?.message ?? error) + ' @ ' +
            String(error?.stack ?? '').split('\n')[1];
        }
        console.error('[frame]', error);
      }
    };
    requestAnimationFrame(loop);
  } catch (error) {
    console.error('[boot] 启动失败', error);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div style="position:fixed;inset:0;display:grid;place-items:center;background:#06090f;color:#ff9a8a;font-size:14px;z-index:99">
         启动失败：${error?.message ?? '未知错误'}（详见控制台）
       </div>`
    );
  }
}

boot();

// 线上站点注册 Service Worker：大体量资源（场景 GLB / 解码器 / 构建产物）
// 首次下载后进入缓存，二次访问即时加载。本地开发服务器不注册。
if (location.hostname.includes('github.io') && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
