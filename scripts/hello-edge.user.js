// ==UserScript==
// @name         Edge 手机端示例脚本
// @namespace    https://github.com/nimao666
// @version      1.0.0
// @description  一个安全的 Tampermonkey 示例：在 example.com 页面右下角显示一个按钮
// @author       nimao666
// @match        https://example.com/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  GM_addStyle(`
    #tm-demo-button {
      position: fixed;
      right: 16px;
      bottom: 80px;
      z-index: 999999;
      padding: 10px 14px;
      border-radius: 999px;
      background: #1f6feb;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,.25);
      cursor: pointer;
      user-select: none;
    }
  `);

  const btn = document.createElement('button');
  btn.id = 'tm-demo-button';
  btn.textContent = '脚本已运行';
  btn.addEventListener('click', () => {
    alert('Tampermonkey 示例脚本运行正常');
  });

  document.body.appendChild(btn);
})();
