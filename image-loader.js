(() => {
  "use strict";

  const IMAGE_PARTS = [
    "./assets/lucky.part0.txt",
    "./assets/lucky.part1.txt",
    "./assets/lucky.part2.txt",
    "./assets/lucky.part3.txt"
  ];

  async function loadCharacterImage() {
    const image = document.getElementById("characterImage");
    if (!image) return;

    try {
      const parts = await Promise.all(
        IMAGE_PARTS.map(async (path) => {
          const response = await fetch(path, { cache: "force-cache" });
          if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
          return (await response.text()).trim();
        })
      );

      image.src = `data:image/webp;base64,${parts.join("")}`;
    } catch (error) {
      console.error("Character image load failed", error);
      const status = document.getElementById("stageStatus");
      if (status) status.textContent = "캐릭터 이미지를 불러오지 못했습니다.";
    }
  }

  loadCharacterImage();
})();
