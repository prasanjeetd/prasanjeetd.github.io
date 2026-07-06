// ==========================================================================
// Prasanjeet Debnath — Portfolio interactions
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const header = document.getElementById('siteHeader');
  const navToggle = document.getElementById('navToggle');
  const navMobile = document.getElementById('navMobile');
  const yearEl = document.getElementById('year');

  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ---- Sticky header background on scroll ----
  const onScroll = () => {
    if (window.scrollY > 20) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // ---- Mobile nav toggle ----
  if (navToggle && navMobile) {
    navToggle.addEventListener('click', () => {
      navToggle.classList.toggle('active');
      navMobile.classList.toggle('open');
    });

    navMobile.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        navToggle.classList.remove('active');
        navMobile.classList.remove('open');
      });
    });
  }

  // ---- Reveal on scroll ----
  const revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry, i) => {
          if (entry.isIntersecting) {
            const el = entry.target;
            const delay = (i % 6) * 60;
            setTimeout(() => el.classList.add('is-visible'), delay);
            observer.unobserve(el);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    revealEls.forEach((el) => observer.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  }

  // ---- Active nav link highlight ----
  const sections = document.querySelectorAll('main section[id]');
  const navLinks = document.querySelectorAll('.nav-desktop a[href^="#"]');

  const highlightNav = () => {
    let currentId = '';
    const scrollPos = window.scrollY + window.innerHeight * 0.35;

    sections.forEach((section) => {
      if (scrollPos >= section.offsetTop) {
        currentId = section.id;
      }
    });

    navLinks.forEach((link) => {
      const href = link.getAttribute('href').replace('#', '');
      link.style.color = href === currentId ? 'var(--ink)' : '';
    });
  };
  highlightNav();
  window.addEventListener('scroll', highlightNav, { passive: true });

  // ---- Smooth anchor scrolling with header offset ----
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href');
      if (targetId.length <= 1) return;
      const target = document.querySelector(targetId);
      if (!target) return;
      e.preventDefault();
      const headerHeight = header ? header.offsetHeight : 0;
      const top = target.getBoundingClientRect().top + window.scrollY - headerHeight + 1;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });
});
