interface ModalOverlayProps {
  children: React.ReactNode;
  onClose: () => void;
}

export default function ModalOverlay({ children, onClose }: ModalOverlayProps) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card" style={{ maxWidth: 560 }}>
        {children}
      </div>
    </div>
  );
}
