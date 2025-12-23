/**
 * VisBug-like Editor
 * Allows inline editing, dragging, and styling of elements with server perseverance.
 */

class VisBugEditor {
    constructor() {
        this.isActive = false;
        this.selectedElement = null;
        this.hoveredElement = null;
        this.edits = {}; // key: selector, value: { style: {}, text: string, src: string }
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.elemStartX = 0;
        this.elemStartY = 0;
        this.apiBase = window.location.origin;

        this.init();
    }

    async init() {
        this.createUI();
        await this.loadEdits();
        this.applyEdits();
    }

    createUI() {
        // Toggle Button
        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '✎ Editor Mode';
        toggleBtn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 10000;
            padding: 10px 20px;
            background: #222;
            color: #fff;
            border: 1px solid #444;
            border-radius: 5px;
            cursor: pointer;
            font-family: sans-serif;
            box-shadow: 0 4px 10px rgba(0,0,0,0.5);
        `;
        toggleBtn.onclick = () => this.toggleMode();
        document.body.appendChild(toggleBtn);
        this.toggleBtn = toggleBtn;

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.id = 'visbug-toolbar';
        toolbar.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 300px;
            background: rgba(30, 30, 30, 0.95);
            color: #eee;
            border: 1px solid #555;
            border-radius: 8px;
            padding: 15px;
            z-index: 10001;
            display: none;
            font-family: sans-serif;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            backdrop-filter: blur(5px);
        `;
        toolbar.innerHTML = `
            <div style="display:flex; justify-content:space-between; margin-bottom:15px; align-items:center;">
                <h3 style="margin:0; font-size:16px;">Style Editor</h3>
                <button id="visbug-save" style="background:#28a745; border:none; color:white; padding:5px 10px; border-radius:4px; cursor:pointer;">Save Changes</button>
            </div>
            
            <div class="vb-control-group" style="margin-bottom:10px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:4px;">Text Color</label>
                <input type="color" id="vb-color" style="width:100%; height:30px; border:none; padding:0;">
            </div>

            <div class="vb-control-group" style="margin-bottom:10px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:4px;">Background</label>
                <input type="color" id="vb-bg" style="width:100%; height:30px; border:none; padding:0;">
            </div>

             <div class="vb-control-group" style="margin-bottom:10px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:4px;">Font Size (px)</label>
                <input type="number" id="vb-fontsize" style="width:100%; background:#444; border:1px solid #555; color:white; padding:5px; border-radius:4px;">
            </div>

            <div class="vb-control-group" style="margin-bottom:10px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:4px;">Padding (px)</label>
                <input type="text" id="vb-padding" placeholder="e.g. 10px 20px" style="width:100%; background:#444; border:1px solid #555; color:white; padding:5px; border-radius:4px;">
            </div>

            <div class="vb-control-group" style="margin-bottom:10px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:4px;">Margin (px)</label>
                <input type="text" id="vb-margin" placeholder="e.g. 10px auto" style="width:100%; background:#444; border:1px solid #555; color:white; padding:5px; border-radius:4px;">
            </div>

             <div class="vb-control-group" style="margin-bottom:10px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:4px;">Text Align</label>
                <select id="vb-align" style="width:100%; background:#444; border:1px solid #555; color:white; padding:5px; border-radius:4px;">
                    <option value="">Default</option>
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                </select>
            </div>
        `;
        document.body.appendChild(toolbar);
        this.toolbar = toolbar;

        // Bind Toolbar Events
        document.getElementById('visbug-save').onclick = () => this.saveEdits();

        const bindInput = (id, prop) => {
            const el = document.getElementById(id);
            el.oninput = (e) => {
                if (this.selectedElement) {
                    let val = e.target.value;
                    if (prop === 'fontSize' && val) val += 'px';
                    this.updateStyle(this.selectedElement, prop, val);
                }
            };
        };

        bindInput('vb-color', 'color');
        bindInput('vb-bg', 'backgroundColor');
        bindInput('vb-fontsize', 'fontSize');
        bindInput('vb-padding', 'padding');
        bindInput('vb-margin', 'margin');
        bindInput('vb-align', 'textAlign');

        // Overlay for selection
        this.overlay = document.createElement('div');
        this.overlay.style.cssText = `
            position: absolute;
            border: 2px solid #00d4ff;
            background: rgba(0, 212, 255, 0.1);
            pointer-events: none;
            z-index: 9999;
            display: none;
            transition: all 0.1s ease;
        `;
        document.body.appendChild(this.overlay);
    }

    toggleMode() {
        this.isActive = !this.isActive;
        this.toggleBtn.textContent = this.isActive ? '✕ Exit Editor' : '✎ Editor Mode';
        this.toolbar.style.display = this.isActive ? 'block' : 'none';
        this.overlay.style.display = 'none';

        if (this.isActive) {
            this.enableEditor();
        } else {
            this.disableEditor();
        }
    }

    enableEditor() {
        document.body.style.cursor = 'default';
        document.addEventListener('mouseover', this.onHover);
        document.addEventListener('click', this.onClick);
        document.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('dblclick', this.onDoubleClick);
    }

    disableEditor() {
        document.body.style.cursor = '';
        document.removeEventListener('mouseover', this.onHover);
        document.removeEventListener('click', this.onClick);
        document.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('dblclick', this.onDoubleClick);
        if (this.selectedElement) {
            this.selectedElement.blur(); // Stop editing text
            this.selectedElement.contentEditable = 'false';
        }
        this.overlay.style.display = 'none';
        this.selectedElement = null;
    }

    onHover = (e) => {
        if (this.isDragging) return;
        if (this.toolbar.contains(e.target) || this.toggleBtn.contains(e.target)) return;

        this.hoveredElement = e.target;
        this.highlight(e.target);
    }

    onClick = (e) => {
        if (this.toolbar.contains(e.target) || this.toggleBtn.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation(); // Stop links from navigating
        this.selectElement(e.target);
    }

    onDoubleClick = (e) => {
        if (!this.isActive || !this.selectedElement) return;
        if (this.toolbar.contains(e.target) || this.toggleBtn.contains(e.target)) return;

        // Enable text editing
        e.target.contentEditable = 'true';
        e.target.focus();

        // Save text change on blur
        e.target.onblur = () => {
            e.target.contentEditable = 'false';
            this.recordEdit(e.target, 'text', e.target.innerHTML);
        };
    }

    onMouseDown = (e) => {
        if (!this.isActive || !this.selectedElement) return;
        if (e.target !== this.selectedElement) return;
        if (this.selectedElement.isContentEditable) return; // Don't drag if editing text

        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;

        // Get current transform
        const style = window.getComputedStyle(this.selectedElement);
        const matrix = new WebKitCSSMatrix(style.transform);
        this.elemStartX = matrix.m41;
        this.elemStartY = matrix.m42;

        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
    }

    onMouseMove = (e) => {
        if (!this.isDragging) return;

        const deltaX = e.clientX - this.dragStartX;
        const deltaY = e.clientY - this.dragStartY;

        const newX = this.elemStartX + deltaX;
        const newY = this.elemStartY + deltaY;

        this.selectedElement.style.transform = `translate(${newX}px, ${newY}px)`;
        this.highlight(this.selectedElement); // Update overlay position
    }

    onMouseUp = () => {
        if (!this.isDragging) return;
        this.isDragging = false;

        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);

        // Save position
        const style = this.selectedElement.style;
        this.recordEdit(this.selectedElement, 'style', { transform: style.transform });
    }

    highlight(el) {
        const rect = el.getBoundingClientRect();
        this.overlay.style.display = 'block';
        this.overlay.style.top = (rect.top + window.scrollY) + 'px';
        this.overlay.style.left = (rect.left + window.scrollX) + 'px';
        this.overlay.style.width = rect.width + 'px';
        this.overlay.style.height = rect.height + 'px';
    }

    selectElement(el) {
        this.selectedElement = el;
        this.highlight(el);

        // Populate toolbar with current styles
        const computed = window.getComputedStyle(el);

        // Convert rgb to hex for input type=color
        const rgbToHex = (rgb) => {
            if (!rgb || rgb === 'rgba(0, 0, 0, 0)') return '#000000';
            const rgbMatch = rgb.match(/\d+/g);
            if (!rgbMatch) return '#000000';
            return '#' + rgbMatch.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
        };

        document.getElementById('vb-color').value = rgbToHex(computed.color);
        document.getElementById('vb-bg').value = rgbToHex(computed.backgroundColor);
        document.getElementById('vb-fontsize').value = parseInt(computed.fontSize);
        document.getElementById('vb-padding').value = computed.padding;
        document.getElementById('vb-margin').value = computed.margin;
        document.getElementById('vb-align').value = computed.textAlign;
    }

    updateStyle(el, prop, value) {
        el.style[prop] = value;
        this.recordEdit(el, 'style', { [prop]: value });
    }

    getSelector(el) {
        if (el.id) return '#' + el.id;
        if (el.className && typeof el.className === 'string' && el.className.trim()) {
            return '.' + el.className.trim().split(/\s+/).join('.');
        }
        // Fallback to simpler path if no ID/Class (can be flaky but okay for MVP)
        let path = el.tagName.toLowerCase();
        if (el.parentElement) {
            const siblings = Array.from(el.parentElement.children);
            const index = siblings.indexOf(el);
            path += `:nth-child(${index + 1})`;
        }
        return path;
    }

    // Robust selector generator
    getUniqueSelector(el) {
        if (el.id) return '#' + el.id;

        const path = [];
        while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id) {
                selector = '#' + el.id;
                path.unshift(selector);
                break;
            } else {
                let sib = el, nth = 1;
                while (sib = sib.previousElementSibling) {
                    if (sib.nodeName.toLowerCase() == selector) nth++;
                }
                if (nth != 1) selector += ":nth-of-type(" + nth + ")";
            }
            path.unshift(selector);
            el = el.parentNode;
        }
        return path.join(" > ");
    }

    recordEdit(el, type, data) {
        const selector = this.getUniqueSelector(el);
        if (!this.edits[selector]) {
            this.edits[selector] = { style: {} };
        }

        if (type === 'text') {
            this.edits[selector].text = data;
        } else if (type === 'style') {
            Object.assign(this.edits[selector].style, data);
        }
    }

    async saveEdits() {
        const path = window.location.pathname;
        try {
            const res = await fetch(`${this.apiBase}/api/page-edits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, edits: this.edits })
            });
            if (res.ok) {
                alert('Changes saved successfully!');
            } else {
                alert('Failed to save changes.');
            }
        } catch (e) {
            console.error(e);
            alert('Error saving changes.');
        }
    }

    async loadEdits() {
        const path = window.location.pathname;
        try {
            const res = await fetch(`${this.apiBase}/api/page-edits?path=${encodeURIComponent(path)}`);
            if (res.ok) {
                const data = await res.json();
                this.edits = data || {};
            }
        } catch (e) {
            console.error('Failed to load edits', e);
        }
    }

    applyEdits() {
        for (const [selector, data] of Object.entries(this.edits)) {
            const el = document.querySelector(selector);
            if (el) {
                if (data.style) {
                    Object.assign(el.style, data.style);
                }
                if (data.text) {
                    el.innerHTML = data.text;
                }
            }
        }
    }
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
    window.visBugEditor = new VisBugEditor();
});
