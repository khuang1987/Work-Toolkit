// 在 Windchill 页面自己的 JavaScript 上下文中触发 ExtJS 控件动作。
// 内容脚本与页面脚本隔离，直接调用 .click() 可能不会触发旧版 Windchill 的控件监听。
(function () {
  'use strict';

  if (window.top !== window) return;

  function clickWithMouse(element) {
    if (!element) return;
    const options = { bubbles: true, cancelable: true, view: window, button: 0, detail: 1 };
    element.dispatchEvent(new MouseEvent('mousedown', { ...options, buttons: 1 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }));
  }

  function findElement(detail) {
    if (detail.id) return document.getElementById(detail.id);
    if (detail.selector) return document.querySelector(detail.selector);
    return null;
  }

  function acknowledge(detail) {
    if (detail.token) document.documentElement.setAttribute('data-wca-bridge-last-action', detail.token);
  }

  document.addEventListener('windchill-assistant:native-action', (event) => {
    const detail = event.detail || {};
    const element = findElement(detail);
    if (!element) return;

    if (detail.action === 'checkbox') {
      if (Boolean(element.checked) !== Boolean(detail.checked)) clickWithMouse(element);
      acknowledge(detail);
      return;
    }

    if (detail.action === 'navigation'
      && window.PTC?.navigator?.selectNavigatorTab) {
      window.PTC.navigator.selectNavigatorTab('object_search_navigation', {
        target: element,
        preventDefault() {},
        stopPropagation() {}
      });
      acknowledge(detail);
      return;
    }

    if (detail.action === 'navigation') {
      // 某些 Windchill 信息页没有把 PTC.navigator 暴露到当前页面上下文，
      // 仍然用页面上下文的真实鼠标事件触发内联导航处理器。
      clickWithMouse(element);
      acknowledge(detail);
      return;
    }

    if (detail.action === 'key') {
      element.focus?.();
      const key = detail.key || {};
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        element.dispatchEvent(new KeyboardEvent(type, {
          key: key.key || 'Enter',
          code: key.code || 'Enter',
          keyCode: key.keyCode || 13,
          which: key.which || 13,
          bubbles: true,
          cancelable: true
        }));
      });
      acknowledge(detail);
      return;
    }

    if (detail.action === 'click') {
      clickWithMouse(element);
      acknowledge(detail);
    }
  });
})();
