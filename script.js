document.addEventListener('DOMContentLoaded', function() {
  // Initialize Materialize scrollspy for active navigation highlighting
  var scrollElems = document.querySelectorAll('.scrollspy');
  M.ScrollSpy.init(scrollElems, { scrollOffset: 60 });

  // Initialize AOS for smooth scroll animations (triggers on both scroll down/up)
  AOS.init({
    duration: 1000,
    once: false
  });

  // Initialize Materialize sidenav for mobile navigation
  var sidenavElems = document.querySelectorAll('.sidenav');
  M.Sidenav.init(sidenavElems);
});
