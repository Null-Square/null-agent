import html2pdf from 'html2pdf.js';

interface Html2PdfOptions {
    margin?: number | [number, number] | [number, number, number, number];
    filename?: string;
    image?: {
        type?: 'jpeg' | 'png' | 'webp';
        quality?: number;
    };
    enableLinks?: boolean;
    html2canvas?: Record<string, unknown>;
    jsPDF?: {
        unit?: string;
        format?: string | [number, number];
        orientation?: 'portrait' | 'landscape';
    };
    pagebreak?: {
        mode?: string[];
    };
}

type PDFOptions = Partial<Html2PdfOptions>;

const waitForImages = async (element: HTMLElement): Promise<void> => {
    const images = Array.from(element.querySelectorAll('img'));
    if (images.length === 0) {
        return;
    }

    await Promise.all(
        images.map(
            (image) =>
                new Promise<void>((resolve) => {
                    if (image.complete && image.naturalWidth > 0) {
                        resolve();
                        return;
                    }

                    const timeout = window.setTimeout(resolve, 3_000);
                    const done = () => {
                        window.clearTimeout(timeout);
                        resolve();
                    };

                    image.addEventListener('load', done, { once: true });
                    image.addEventListener('error', done, { once: true });
                }),
        ),
    );
};

export const generatePDF = async (element: HTMLElement, options: PDFOptions = {}) => {
    const defaultOptions = {
        margin: [10, 10, 10, 10], // top, left, bottom, right
        filename: 'report.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
            scale: 2, // Higher scale for better resolution
            useCORS: true, // Allow loading cross-origin images
            logging: false,
            backgroundColor: '#000000', // Ensure background matches our theme
            windowWidth: 1200 // Fix width to ensure consistent rendering
        },
        jsPDF: {
            unit: 'mm',
            format: 'a4',
            orientation: 'portrait'
        },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    };

    const config = { ...defaultOptions, ...options } as Html2PdfOptions;

    // Add a class to the element during generation to apply specific print styles if needed
    const originalClass = element.className;
    element.classList.add('printing-pdf');

    try {
        await waitForImages(element);
        await html2pdf().set(config).from(element).save();
    } finally {
        element.className = originalClass;
    }
};

export const createPDFBlob = async (element: HTMLElement, options: PDFOptions = {}): Promise<Blob> => {
    const defaultOptions = {
        margin: [10, 10, 10, 10],
        filename: 'report.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
            scale: 2,
            useCORS: true,
            logging: false,
            backgroundColor: '#ffffff',
            windowWidth: 1200
        },
        jsPDF: {
            unit: 'mm',
            format: 'a4',
            orientation: 'portrait'
        },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    };

    const config = { ...defaultOptions, ...options } as Html2PdfOptions;
    const originalClass = element.className;
    element.classList.add('printing-pdf');

    try {
        await waitForImages(element);
        return html2pdf().set(config).from(element).outputPdf('blob');
    } finally {
        element.className = originalClass;
    }
};
