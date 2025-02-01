document.addEventListener('DOMContentLoaded', function() {
  // Initialize Materialize ScrollSpy for active navigation highlighting
  var scrollElems = document.querySelectorAll('.scrollspy');
  M.ScrollSpy.init(scrollElems, { scrollOffset: 60 });

  // Initialize AOS for smooth scroll animations (triggers on scroll down/up)
  AOS.init({
    duration: 1000,
    once: false
  });

  // Initialize Materialize Sidenav for mobile navigation
  var sidenavElems = document.querySelectorAll('.sidenav');
  M.Sidenav.init(sidenavElems);

  // Canvas Particle Effect (inspired by CodePen: https://codepen.io/thebabydino/pen/XWywJMW)
  (function() {
    const canvas = document.getElementById('effect-canvas');
    const ctx = canvas.getContext('2d');
    let width, height;
    
    function resize() {
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
    }
    window.addEventListener('resize', resize);
    resize();
    
    const particles = [];
    const numParticles = 50;
    
    function Particle() {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.radius = Math.random() * 2 + 1;
      this.vx = Math.random() * 0.5 - 0.25;
      this.vy = Math.random() * 0.5 - 0.25;
      this.alpha = Math.random() * 0.5 + 0.5;
    }
    
    Particle.prototype.update = function() {
      this.x += this.vx;
      this.y += this.vy;
      // Wrap around the edges
      if (this.x < 0) this.x = width;
      if (this.x > width) this.x = 0;
      if (this.y < 0) this.y = height;
      if (this.y > height) this.y = 0;
    };
    
    Particle.prototype.draw = function() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2, false);
      ctx.fillStyle = `rgba(255, 255, 255, ${this.alpha})`;
      ctx.fill();
    };
    
    function initParticles() {
      for (let i = 0; i < numParticles; i++) {
        particles.push(new Particle());
      }
    }
    
    function animateParticles() {
      ctx.clearRect(0, 0, width, height);
      particles.forEach(p => {
        p.update();
        p.draw();
      });
      requestAnimationFrame(animateParticles);
    }
    
    initParticles();
    animateParticles();
  })();
});
