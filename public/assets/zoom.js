(function () {
  'use strict';

  var MIN = 0.5;
  var MAX = 5;

  function clamp(v) {
    return Math.max(MIN, Math.min(MAX, v));
  }

  function distance(touches) {
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function enable(container, img) {
    var scale = 1;
    var x = 0;
    var y = 0;
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    var pinchStart = 0;
    var pinchScale = 1;

    function apply() {
      img.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
    }

    function setScale(nextScale) {
      scale = clamp(nextScale);
      x = 0;
      y = 0;
      apply();
    }

    container.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var factor = e.deltaY > 0 ? 0.88 : 1.14;
        setScale(scale * factor);
      },
      { passive: false }
    );

    container.addEventListener('dblclick', function (e) {
      setScale(scale > 1.15 ? 1 : 2);
    });

    container.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      container.classList.add('dragging');
      try {
        container.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    container.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      x += e.clientX - lastX;
      y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    });

    function stopDrag() {
      dragging = false;
      container.classList.remove('dragging');
    }
    container.addEventListener('pointerup', stopDrag);
    container.addEventListener('pointercancel', stopDrag);

    container.addEventListener(
      'touchstart',
      function (e) {
        if (e.touches.length === 2) {
          pinchStart = distance(e.touches);
          pinchScale = scale;
        } else if (e.touches.length === 1 && scale > 1) {
          dragging = true;
          lastX = e.touches[0].clientX;
          lastY = e.touches[0].clientY;
        }
      },
      { passive: true }
    );

    container.addEventListener(
      'touchmove',
      function (e) {
        e.preventDefault();
        if (e.touches.length === 2 && pinchStart > 0) {
          var d = distance(e.touches);
          scale = clamp(pinchScale * (d / pinchStart));
          x = 0;
          y = 0;
          apply();
        } else if (e.touches.length === 1 && dragging) {
          x += e.touches[0].clientX - lastX;
          y += e.touches[0].clientY - lastY;
          lastX = e.touches[0].clientX;
          lastY = e.touches[0].clientY;
          apply();
        }
      },
      { passive: false }
    );

    container.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) pinchStart = 0;
      if (e.touches.length === 0) dragging = false;
    });

    apply();

    return {
      zoomIn: function () {
        setScale(scale * 1.25);
      },
      zoomOut: function () {
        setScale(scale / 1.25);
      },
      reset: function () {
        setScale(1);
      },
      getScale: function () {
        return scale;
      },
    };
  }

  window.ImageZoom = { enable: enable };
})();