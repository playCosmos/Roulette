(() => {
  "use strict";

  const IMAGE_VERSION = "20260911-teeth-v2";
  const IMAGE_PARTS = [
    "./assets/lucky.part0.txt",
    "./assets/lucky.part1.txt",
    "./assets/lucky.part2.txt",
    "./assets/lucky.part3.txt"
  ];

  async function loadCharacterImage() {
    const image = document.getElementById("characterImage");
    const stage = document.getElementById("characterStage");
    const loading = document.getElementById("imageLoading");
    const status = document.getElementById("stageStatus");
    if (!image || !stage) return;

    try {
      const parts = await Promise.all(IMAGE_PARTS.map(async (path) => {
        const response = await fetch(`${path}?v=${IMAGE_VERSION}`, { cache: "no-cache" });
        if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
        return (await response.text()).trim();
      }));

      image.src = `data:image/webp;base64,${parts.join("")}`;
      await image.decode();
      stage.classList.add("image-ready");
      if (loading) loading.textContent = "";
    } catch (error) {
      console.error("Character image load failed", error);
      if (loading) loading.textContent = "캐릭터 이미지를 불러오지 못했습니다.";
      if (status) status.textContent = "이미지 로딩 오류 · 새로고침해 주세요";
    }
  }

  loadCharacterImage();
})();
