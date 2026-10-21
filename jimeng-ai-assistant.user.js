// ==UserScript==
// @name         即梦 AI 无水印原图与智能裁剪助手
// @namespace    https://github.com/hellomaxfan
// @version      2.5.0
// @description  支持右键保存原图、等比微裁及在线交互裁剪（去水印）
// @author       hellomaxfan
// @match        *://jimeng.jianying.com/*
// @match        *://*.jianying.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/hellomaxfan/jimeng-ai-assistant/main/jimeng-ai-assistant.user.js
// @updateURL    https://raw.githubusercontent.com/hellomaxfan/jimeng-ai-assistant/main/jimeng-ai-assistant.user.js
// ==/UserScript==

(function () {
  'use strict';

  let currentTargetImgSrc = null;
  let activeLoadedImage = null; // 缓存当前操作的 Image 对象

  // ================= 1. 右键菜单与基础样式 =================
  const menu = document.createElement("div");
  menu.id = "__jm_pure_context_menu__";
  Object.assign(menu.style, {
    position: "fixed",
    display: "none",
    zIndex: "99999999",
    backgroundColor: "#18181b",
    border: "1px solid #27272a",
    borderRadius: "8px",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",
    padding: "6px 0",
    minWidth: "190px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "13px",
    color: "#f4f4f5"
  });

  const style = document.createElement("style");
  style.innerText = `
    .jm-pure-item {
      padding: 9px 16px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      display: flex;
      align-items: center;
      user-select: none;
      font-weight: 500;
    }
    .jm-pure-item:hover {
      background-color: #2563eb;
      color: #ffffff;
    }
    .jm-divider {
      height: 1px;
      background: #27272a;
      margin: 4px 0;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(menu);

  // ================= 2. 提取最高清原图直链 =================
  function getCleanImageUrl(target) {
    if (!target) return null;
    let rawSrc = null;

    if (target.tagName === 'IMG' && target.src) rawSrc = target.src;
    else {
      const img = target.querySelector('img') || target.closest('div')?.querySelector('img');
      if (img && img.src) rawSrc = img.src;
    }

    if (!rawSrc) {
      const bg = window.getComputedStyle(target).backgroundImage;
      if (bg && bg.startsWith('url(')) rawSrc = bg.slice(5, -2).replace(/['"]/g, '');
    }

    if (!rawSrc) return null;

    try {
      let cleanUrl = rawSrc;
      if (cleanUrl.includes('~tplv-')) {
        cleanUrl = cleanUrl.replace(/~tplv-[a-z0-9-]+:[a-z0-9-]+/i, '');
      }
      return cleanUrl;
    } catch (e) {
      return rawSrc;
    }
  }

  // ================= 3. 监听右键弹出菜单 =================
  document.addEventListener("contextmenu", (e) => {
    if (e.shiftKey) return; // Shift + 右键恢复浏览器原生菜单

    const imgSrc = getCleanImageUrl(e.target);
    if (!imgSrc) {
      hideMenu();
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    currentTargetImgSrc = imgSrc;
    showMenu(e.clientX, e.clientY);
  }, true);

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target)) hideMenu();
  });
  window.addEventListener("scroll", hideMenu, true);

  function showMenu(x, y) {
    menu.innerHTML = `
      <div class="jm-pure-item" id="jm_quick_crop_save">✂️ 等比裁掉右上角并保存</div>
      <div class="jm-pure-item" id="jm_open_crop_modal">🎨 打开在线裁剪微调...</div>
      <div class="jm-divider"></div>
      <div class="jm-pure-item" id="jm_save_raw">💾 保存原始图片 (不裁切)</div>
      <div class="jm-pure-item" id="jm_copy_raw">📋 复制原始图片 (不裁切)</div>
    `;

    const menuW = 190, menuH = 160;
    const posX = (x + menuW > window.innerWidth) ? x - menuW : x;
    const posY = (y + menuH > window.innerHeight) ? y - menuH : y;

    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;
    menu.style.display = "block";

    // 快捷：等比向中心微缩 5% 裁掉右上角
    document.getElementById("jm_quick_crop_save").onclick = () => {
      hideMenu();
      handleQuickCenterCrop(0.05, "save");
    };
    // 弹窗：打开在线裁剪器
    document.getElementById("jm_open_crop_modal").onclick = () => {
      hideMenu();
      openCropEditorModal();
    };
    // 原始操作
    document.getElementById("jm_save_raw").onclick = () => { hideMenu(); handleRawAction("save"); };
    document.getElementById("jm_copy_raw").onclick = () => { hideMenu(); handleRawAction("copy"); };
  }

  function hideMenu() {
    menu.style.display = "none";
  }

  // ================= 4. 等比向中心裁切核心计算 =================
  // ratio 为向内收缩比例（例如 0.05 代表四周各裁掉 5%）
  function createCenterCroppedBlob(img, ratio = 0.05) {
    return new Promise((resolve) => {
      const canvas = document.createElement("canvas");
      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;

      // 计算向中心缩小的源图抓取范围
      const cropX = srcW * ratio;
      const cropY = srcH * ratio;
      const cropW = srcW * (1 - ratio * 2);
      const cropH = srcH * (1 - ratio * 2);

      // 输出高保真像素
      canvas.width = Math.round(cropW);
      canvas.height = Math.round(cropH);

      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      // 将中心主体无损画到新 Canvas 上
      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  // 一键快速等比裁切
  async function handleQuickCenterCrop(ratio, action) {
    if (!currentTargetImgSrc) return;
    showToast("✂️ 正在等比裁切去除右上角水印...");
    try {
      const blob = await fetchImageBlob(currentTargetImgSrc);
      const img = await loadImageFromBlob(blob);
      const croppedBlob = await createCenterCroppedBlob(img, ratio);

      if (action === "save") {
        downloadBlob(croppedBlob, `jimeng_crop_${Date.now()}.png`);
        showToast("✅ 已成功裁掉右上角并保存！");
      }
    } catch (err) {
      showToast("❌ 裁切失败: " + err.message);
    }
  }

  // 原始无裁切操作
  async function handleRawAction(type) {
    if (!currentTargetImgSrc) return;
    showToast("⏳ 正在提取原图...");
    try {
      const blob = await fetchImageBlob(currentTargetImgSrc);
      if (type === "copy") {
        const pngBlob = await convertToPngBlob(blob);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
        showToast("✅ 已复制原始图片！");
      } else {
        const ext = blob.type.includes("webp") ? "webp" : "png";
        downloadBlob(blob, `jimeng_raw_${Date.now()}.${ext}`);
        showToast("✅ 原始图片已保存！");
      }
    } catch (err) {
      showToast("❌ 操作失败: " + err.message);
    }
  }

  // ================= 5. 在线裁剪编辑弹窗 (UI) =================
  async function openCropEditorModal() {
    showToast("⏳ 正在载入裁剪工具...");
    try {
      const blob = await fetchImageBlob(currentTargetImgSrc);
      activeLoadedImage = await loadImageFromBlob(blob);
    } catch (e) {
      showToast("❌ 图片载入失败: " + e.message);
      return;
    }

    const modal = document.createElement("div");
    modal.id = "__jm_crop_modal__";
    Object.assign(modal.style, {
      position: "fixed",
      top: 0, left: 0, width: "100vw", height: "100vh",
      backgroundColor: "rgba(0, 0, 0, 0.75)",
      backdropFilter: "blur(6px)",
      zIndex: "100000000",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    });

    modal.innerHTML = `
      <div style="background:#18181b; border:1px solid #27272a; border-radius:12px; width:92%; max-width:680px; padding:20px; box-shadow:0 16px 36px rgba(0,0,0,0.6); color:#fff; display:flex; flex-direction:column; gap:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0; font-size:16px; font-weight:600;">🎨 在线微调裁剪（无痕去除右上角水印）</h3>
          <span id="jm_close_modal" style="cursor:pointer; font-size:20px; color:#a1a1aa;">✕</span>
        </div>

        <!-- 预览画布容器 -->
        <div style="display:flex; justify-content:center; align-items:center; background:#09090b; border-radius:8px; padding:12px; max-height:420px; overflow:hidden;">
          <canvas id="jm_preview_canvas" style="max-width:100%; max-height:380px; object-fit:contain; border-radius:4px; box-shadow:0 0 10px rgba(0,0,0,0.5);"></canvas>
        </div>

        <!-- 控制工具条 -->
        <div style="background:#27272a; padding:12px 16px; border-radius:8px; display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:13px; font-weight:500;">向中心等比缩拢深度（裁切边缘）：</span>
            <span id="jm_ratio_text" style="font-size:13px; color:#60a5fa; font-weight:bold;">5% (推荐)</span>
          </div>
          <input type="range" id="jm_crop_slider" min="0" max="15" step="0.5" value="5" style="width:100%; cursor:pointer;">
          <div style="font-size:11px; color:#a1a1aa;">
            💡 提示：一般 4%~6% 即可完美裁掉右上角的「AI生成」标识，且几乎看不出画面被缩小。
          </div>
        </div>

        <!-- 底部按钮 -->
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button id="jm_modal_copy" style="padding:8px 16px; border:1px solid #3f3f46; background:#27272a; color:#fff; border-radius:6px; cursor:pointer; font-size:13px;">📋 复制裁剪后图片</button>
          <button id="jm_modal_save" style="padding:8px 20px; border:none; background:#2563eb; color:#fff; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600;">💾 保存裁剪后图片</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const canvas = modal.querySelector("#jm_preview_canvas");
    const slider = modal.querySelector("#jm_crop_slider");
    const ratioText = modal.querySelector("#jm_ratio_text");

    // 实时更新预览画面
    function updatePreview(pct) {
      ratioText.innerText = `${pct}% ${pct === 5 ? '(推荐)' : ''}`;
      const ratio = pct / 100;
      const srcW = activeLoadedImage.naturalWidth;
      const srcH = activeLoadedImage.naturalHeight;

      const cropX = srcW * ratio;
      const cropY = srcH * ratio;
      const cropW = srcW * (1 - ratio * 2);
      const cropH = srcH * (1 - ratio * 2);

      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(activeLoadedImage, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    }

    // 初始化渲染 5%
    updatePreview(5);

    // 滑动监听
    slider.oninput = (e) => updatePreview(parseFloat(e.target.value));

    // 关闭弹窗
    modal.querySelector("#jm_close_modal").onclick = () => modal.remove();

    // 保存
    modal.querySelector("#jm_modal_save").onclick = async () => {
      const pct = parseFloat(slider.value);
      showToast("⏳ 正在生成高清裁剪图...");
      const croppedBlob = await createCenterCroppedBlob(activeLoadedImage, pct / 100);
      downloadBlob(croppedBlob, `jimeng_crop_${Date.now()}.png`);
      modal.remove();
      showToast("✅ 裁剪图片已保存！");
    };

    // 复制到剪贴板
    modal.querySelector("#jm_modal_copy").onclick = async () => {
      const pct = parseFloat(slider.value);
      const croppedBlob = await createCenterCroppedBlob(activeLoadedImage, pct / 100);
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": croppedBlob })]);
        modal.remove();
        showToast("✅ 已成功复制裁剪后图片！");
      } catch (err) {
        showToast("❌ 剪贴板受限，请使用保存");
      }
    };
  }

  // ================= 辅助工具方法 =================
  function fetchImageBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "blob",
        onload: (res) => (res.status >= 200 && res.status < 300) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("网络请求超时"))
      });
    });
  }

  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
      img.src = url;
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function convertToPngBlob(blob) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => resolve(b), "image/png");
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }

  function showToast(text) {
    let toast = document.getElementById("__jm_toast__");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__jm_toast__";
      Object.assign(toast.style, {
        position: "fixed",
        top: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(10, 10, 10, 0.9)",
        color: "#fff",
        padding: "8px 18px",
        borderRadius: "20px",
        fontSize: "13px",
        zIndex: "100000001",
        boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
        transition: "opacity 0.2s",
        pointerEvents: "none"
      });
      document.body.appendChild(toast);
    }
    toast.innerText = text;
    toast.style.display = "block";
    toast.style.opacity = "1";
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => { toast.style.display = "none"; }, 200);
    }, 2000);
  }
})();
