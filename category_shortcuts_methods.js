
setupCategoryShortcuts() {
    const categoryNames = {
        anime: 'Anime',
        movies: 'Movies',
        tv: 'Series',
        games: 'Games',
        actors: 'People'
    };

    // Load saved images
    ['anime', 'movies', 'tv', 'games', 'actors'].forEach(cat => {
        const saved = localStorage.getItem(category_img_);
        const img = document.getElementById(img -);
        if (saved && img) {
            img.src = saved;
        }
    });

    // Initialize preview with first category (anime)
    this.updateCategoryPreview('anime');

    // Preview box click - navigate to library
    const previewBox = document.getElementById('categoryPreviewBox');
    if (previewBox) {
        previewBox.addEventListener('click', (e) => {
            // Don't navigate if clicking upload button
            if (e.target.closest('.category-preview-upload-btn') || e.target.closest('.category-preview-upload')) {
                return;
            }

            const category = previewBox.dataset.category;
            this.switchTab(category);
        });

        // Preview upload button
        const previewUploadBtn = previewBox.querySelector('.category-preview-upload-btn');
        const previewFileInput = previewBox.querySelector('.category-preview-upload');

        if (previewUploadBtn && previewFileInput) {
            previewUploadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                previewFileInput.click();
            });

            previewFileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const category = previewBox.dataset.category;
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const base64 = event.target.result;

                        // Update preview image
                        const previewImg = document.getElementById('preview-img');
                        if (previewImg) previewImg.src = base64;

                        // Update small box image
                        const smallImg = document.getElementById(img -);
                        if (smallImg) smallImg.src = base64;

                        // Save to localStorage
                        try {
                            localStorage.setItem(category_img_, base64);
                        } catch (err) {
                            console.error('Failed to save category image to localStorage', err);
                            alert('Image too large to save locally.');
                        }
                    };
                    reader.readAsDataURL(file);
                }
            });
        }
    }

    // Small category boxes
    document.querySelectorAll('.category-box').forEach(box => {
        const category = box.dataset.category;
        const uploadBtn = box.querySelector('.category-upload-btn');
        const fileInput = box.querySelector('.category-upload');
        const img = box.querySelector('.category-img');

        // Click to select and update preview
        box.addEventListener('click', (e) => {
            // Don't select if clicking upload button
            if (e.target.closest('.category-upload-btn') || e.target.closest('.category-upload')) {
                return;
            }

            this.updateCategoryPreview(category);
        });

        // Upload button click
        if (uploadBtn && fileInput) {
            uploadBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent selection
                fileInput.click();
            });

            fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const base64 = event.target.result;
                        if (img) img.src = base64;

                        // Update preview if this category is currently selected
                        const previewBox = document.getElementById('categoryPreviewBox');
                        if (previewBox && previewBox.dataset.category === category) {
                            const previewImg = document.getElementById('preview-img');
                            if (previewImg) previewImg.src = base64;
                        }

                        try {
                            localStorage.setItem(category_img_, base64);
                        } catch (err) {
                            console.error('Failed to save category image to localStorage', err);
                            alert('Image too large to save locally.');
                        }
                    };
                    reader.readAsDataURL(file);
                }
            });
        }
    });
}

updateCategoryPreview(category) {
    const categoryNames = {
        anime: 'Anime',
        movies: 'Movies',
        tv: 'Series',
        games: 'Games',
        actors: 'People'
    };

    const previewBox = document.getElementById('categoryPreviewBox');
    const previewImg = document.getElementById('preview-img');
    const previewName = document.getElementById('preview-name');

    if (!previewBox || !previewImg || !previewName) return;

    // Update preview box data
    previewBox.dataset.category = category;

    // Update preview name with smooth transition
    previewName.style.transition = 'opacity 0.15s ease';
    previewName.style.opacity = '0';
    setTimeout(() => {
        previewName.textContent = categoryNames[category] || category;
        previewName.style.opacity = '1';
    }, 150);

    // Update preview image
    const smallImg = document.getElementById(img -);
    if (smallImg && smallImg.src) {
        previewImg.style.transition = 'opacity 0.15s ease';
        previewImg.style.opacity = '0';
        setTimeout(() => {
            previewImg.src = smallImg.src;
            previewImg.alt = categoryNames[category] || category;
            previewImg.style.opacity = '1';
        }, 150);
    }

    // Update active states
    document.querySelectorAll('.category-box').forEach(box => {
        if (box.dataset.category === category) {
            box.classList.add('active');
        } else {
            box.classList.remove('active');
        }
    });
}

setupSettingsListeners() {
    document.getElementById('saveSettings').addEventListener('click', async () => {
        this.saveSettings();        // update this.data.settings + apply CSS
        await this.persistSettings(); // persist to DuckDB
    });
