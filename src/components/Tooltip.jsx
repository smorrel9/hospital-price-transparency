import { useState, useRef, useEffect } from 'react';

export default function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  const [above, setAbove] = useState(true);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (visible && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      // If too close to the top, show below instead
      setAbove(rect.top > 60);
    }
  }, [visible]);

  if (!text) return children;

  return (
    <span
      ref={wrapperRef}
      className="relative inline-block"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <span className="border-b border-dotted border-gray-400 cursor-help">
        {children}
      </span>
      {visible && (
        <span
          className={`absolute z-50 left-1/2 -translate-x-1/2 px-3 py-2 text-xs text-white bg-gray-800 rounded-lg shadow-lg whitespace-normal max-w-xs w-max pointer-events-none ${
            above ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
        >
          {text}
          <span
            className={`absolute left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45 ${
              above ? 'top-full -mt-1' : 'bottom-full -mb-1'
            }`}
          />
        </span>
      )}
    </span>
  );
}
