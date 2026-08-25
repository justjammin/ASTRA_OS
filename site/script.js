(() => {
  "use strict";

  const root = document.documentElement;
  root.classList.add("js");

  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const nav = document.querySelector("[data-nav]");
  const navToggle = document.querySelector("[data-nav-toggle]");
  const headerLine = document.querySelector("[data-header-line]");
  const year = document.querySelector("[data-year]");
  const navLinks = [...document.querySelectorAll("[data-nav] a[href^='#']")];
  const sections = navLinks
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);
  const gsapApi = globalThis.gsap;

  if (year) year.textContent = String(new Date().getFullYear());

  function closeNavigation() {
    if (!nav || !navToggle) return;
    nav.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
  }

  navToggle?.addEventListener("click", () => {
    const isOpen = nav?.classList.toggle("is-open") ?? false;
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeNavigation));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNavigation();
  });

  const setActiveLink = (id) => {
    navLinks.forEach((link) => {
      const active = link.getAttribute("href") === `#${id}`;
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    const currentIndex = Math.max(0, sections.findIndex((section) => section.id === id));
    if (headerLine) headerLine.style.width = `${Math.min(94, 20 + currentIndex * 12)}%`;
  };

  if ("IntersectionObserver" in window && sections.length) {
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActiveLink(visible.target.id);
      },
      { rootMargin: "-18% 0px -60%", threshold: [0.05, 0.24, 0.5] },
    );
    sections.forEach((section) => sectionObserver.observe(section));
  } else {
    setActiveLink("overview");
  }

  function showElement(element, index = 0) {
    if (!element) return;
    element.classList.add("is-visible");
    if (!gsapApi || prefersReduced?.matches) {
      element.style.opacity = "1";
      element.style.transform = "none";
      return;
    }
    gsapApi.fromTo(
      element,
      { opacity: 0, y: 22 },
      { opacity: 1, y: 0, duration: 0.72, delay: Math.min(index * 0.045, 0.2), ease: "power4.out", overwrite: "auto" },
    );
  }

  const revealItems = [...document.querySelectorAll(".reveal")];
  if (prefersReduced?.matches) root.classList.add("motion-reduced");

  if ("IntersectionObserver" in window && revealItems.length) {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry, index) => {
          if (!entry.isIntersecting) return;
          showElement(entry.target, index);
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10%", threshold: 0.12 },
    );
    revealItems.forEach((item) => revealObserver.observe(item));
  } else {
    revealItems.forEach((item) => showElement(item));
  }

  if (gsapApi) {
    const media = gsapApi.matchMedia();

    media.add("(prefers-reduced-motion: reduce)", () => {
      root.classList.add("motion-reduced");
      gsapApi.set(revealItems, { clearProps: "all", opacity: 1, y: 0 });
      return () => root.classList.remove("motion-reduced");
    });

    media.add("(prefers-reduced-motion: no-preference)", () => {
      const intro = gsapApi.timeline({ defaults: { ease: "power4.out" } });
      intro
        .from(".hero-eyebrow", { opacity: 0, y: 16, duration: 0.55 })
        .from("#hero-title", { opacity: 0, y: 24, duration: 0.78 }, "-=0.24")
        .from(".hero-lede", { opacity: 0, y: 18, duration: 0.58 }, "-=0.32")
        .from(".hero-actions", { opacity: 0, y: 14, duration: 0.5 }, "-=0.22")
        .from(".hero-facts", { opacity: 0, y: 12, duration: 0.5 }, "-=0.18")
        .from("[data-hero-console]", { opacity: 0, x: 34, rotate: 4, duration: 0.9 }, "-=0.74");

      gsapApi.fromTo("[data-header-line]", { xPercent: -100 }, { xPercent: 0, duration: 1.1, delay: 0.3, ease: "expo.out" });
      gsapApi.from(".hero-floor span", { opacity: 0, scale: 0, duration: 0.6, stagger: 0.12, delay: 0.72, ease: "power3.out" });
      return () => intro.kill();
    });
  }

  const copyButton = document.querySelector("[data-copy]");
  const copyStatus = document.querySelector("[data-copy-status]");

  async function copyCommand() {
    if (!copyButton) return;
    const value = copyButton.dataset.copy || "";
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const helper = document.createElement("textarea");
        helper.value = value;
        helper.setAttribute("readonly", "");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.append(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      if (copyStatus) copyStatus.textContent = "Copied to clipboard.";
      window.setTimeout(() => {
        if (copyStatus) copyStatus.textContent = "";
      }, 2200);
    } catch {
      if (copyStatus) copyStatus.textContent = "Select the command above to copy it.";
    }
  }

  copyButton?.addEventListener("click", copyCommand);

  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) closeNavigation();
  }, { passive: true });
})();
