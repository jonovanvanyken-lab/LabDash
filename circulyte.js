/* Circulyte Labs opening splash: shows the mark, app name and company for a moment, then fades. Tap to skip. */
(function () {
  var s = document.getElementById("clSplash"); if (!s) return;
  var done = false;
  function hide() { if (done) return; done = true; s.classList.add("cl-out"); setTimeout(function () { s.remove() }, 500) }
  s.addEventListener("click", hide);
  setTimeout(hide, 1600);
})();
