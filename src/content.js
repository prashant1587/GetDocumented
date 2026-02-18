const CLICK_THROTTLE_MS = 250;
let lastClickAt = 0;

window.addEventListener(
  'click',
  (event) => {
    const now = Date.now();
    if (now - lastClickAt < CLICK_THROTTLE_MS) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    lastClickAt = now;

    const payload = {
      title: buildElementTitle(target),
      selector: buildSelector(target),
      direction: getDirection(event.clientX, event.clientY),
      clickPosition: {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY)
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    };

    chrome.runtime.sendMessage({
      type: 'CLICK_CAPTURED',
      payload
    });
  },
  true
);

function buildElementTitle(element) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  const text = element.textContent?.trim();
  if (text) {
    return text.slice(0, 80);
  }

  const id = element.id ? `#${element.id}` : '';
  return `${element.tagName.toLowerCase()}${id}`;
}

function buildSelector(element) {
  const parts = [];
  let current = element;

  for (let depth = 0; current && depth < 4; depth += 1) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${current.id}`;
      parts.unshift(part);
      break;
    }

    const classes = [...current.classList].slice(0, 2).join('.');
    if (classes) {
      part += `.${classes}`;
    }

    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function getDirection(x, y) {
  const horizontal = x < window.innerWidth / 3 ? 'left' : x > (window.innerWidth * 2) / 3 ? 'right' : 'center';
  const vertical = y < window.innerHeight / 3 ? 'top' : y > (window.innerHeight * 2) / 3 ? 'bottom' : 'middle';

  if (horizontal === 'center' && vertical === 'middle') {
    return 'center';
  }

  if (horizontal === 'center') {
    return vertical;
  }

  if (vertical === 'middle') {
    return horizontal;
  }

  return `${vertical}-${horizontal}`;
}
