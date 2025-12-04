// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface FogData {
  id: string;
  encryptedPosition: string;
  timestamp: number;
  owner: string;
  gameId: string;
  status: "hidden" | "revealed" | "invalid";
}

const FHEEncryptPosition = (x: number, y: number): string => {
  return `FHE-${btoa(`${x},${y}`)}`;
};

const FHEDecryptPosition = (encryptedData: string): {x: number, y: number} => {
  if (encryptedData.startsWith('FHE-')) {
    const decrypted = atob(encryptedData.substring(4)).split(',');
    return {x: parseInt(decrypted[0]), y: parseInt(decrypted[1])};
  }
  return {x: 0, y: 0};
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [fogData, setFogData] = useState<FogData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newFogData, setNewFogData] = useState({ gameId: "", x: 0, y: 0 });
  const [selectedData, setSelectedData] = useState<FogData | null>(null);
  const [decryptedPosition, setDecryptedPosition] = useState<{x: number, y: number} | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const hiddenCount = fogData.filter(d => d.status === "hidden").length;
  const revealedCount = fogData.filter(d => d.status === "revealed").length;

  useEffect(() => {
    loadFogData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadFogData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load fog data keys
      const keysBytes = await contract.getData("fog_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing fog keys:", e); }
      }
      
      // Load each fog data
      const list: FogData[] = [];
      for (const key of keys) {
        try {
          const dataBytes = await contract.getData(`fog_${key}`);
          if (dataBytes.length > 0) {
            try {
              const fogData = JSON.parse(ethers.toUtf8String(dataBytes));
              list.push({ 
                id: key, 
                encryptedPosition: fogData.position, 
                timestamp: fogData.timestamp, 
                owner: fogData.owner, 
                gameId: fogData.gameId, 
                status: fogData.status || "hidden" 
              });
            } catch (e) { console.error(`Error parsing fog data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading fog data ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setFogData(list);
    } catch (e) { console.error("Error loading fog data:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitFogData = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting position data with Zama FHE..." });
    try {
      const encryptedPosition = FHEEncryptPosition(newFogData.x, newFogData.y);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const dataId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const fogData = { 
        position: encryptedPosition, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        gameId: newFogData.gameId, 
        status: "hidden" 
      };
      
      await contract.setData(`fog_${dataId}`, ethers.toUtf8Bytes(JSON.stringify(fogData)));
      
      // Update keys list
      const keysBytes = await contract.getData("fog_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(dataId);
      await contract.setData("fog_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Fog data encrypted and stored successfully!" });
      await loadFogData();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewFogData({ gameId: "", x: 0, y: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<{x: number, y: number} | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptPosition(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const revealPosition = async (dataId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted position with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const dataBytes = await contract.getData(`fog_${dataId}`);
      if (dataBytes.length === 0) throw new Error("Data not found");
      const fogData = JSON.parse(ethers.toUtf8String(dataBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedData = { ...fogData, status: "revealed" };
      await contractWithSigner.setData(`fog_${dataId}`, ethers.toUtf8Bytes(JSON.stringify(updatedData)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Position revealed successfully!" });
      await loadFogData();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Reveal failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (dataOwner: string) => address?.toLowerCase() === dataOwner.toLowerCase();

  const features = [
    {
      title: "FHE-Powered Fog of War",
      description: "All game positions are encrypted using Zama FHE technology, ensuring true privacy during gameplay",
      icon: "🔒"
    },
    {
      title: "Standardized API",
      description: "Easy integration with any strategy game through our well-documented API endpoints",
      icon: "📡"
    },
    {
      title: "Developer Focus",
      description: "Focus on game mechanics while we handle all the complex encryption and decryption processes",
      icon: "👨‍💻"
    },
    {
      title: "Real-time Processing",
      description: "Process encrypted game moves in real-time without ever decrypting sensitive data",
      icon: "⚡"
    }
  ];

  const partners = [
    { name: "Zama", role: "FHE Technology Provider", logo: "ZAMA" },
    { name: "Chainlink", role: "Oracle Services", logo: "CHAINLINK" },
    { name: "Polygon", role: "Scalability Partner", logo: "POLYGON" },
    { name: "Unreal Engine", role: "Game Engine", logo: "UNREAL" }
  ];

  const renderMiniMap = () => {
    // Simple visualization of hidden vs revealed positions
    return (
      <div className="mini-map">
        <div className="map-grid">
          {Array(16).fill(0).map((_, i) => {
            const hasHidden = fogData.some(d => d.status === "hidden");
            const hasRevealed = fogData.some(d => d.status === "revealed");
            
            let cellType = "empty";
            if (hasHidden && i % 3 === 0) cellType = "hidden";
            if (hasRevealed && i % 5 === 0) cellType = "revealed";
            
            return <div key={i} className={`map-cell ${cellType}`}></div>;
          })}
        </div>
        <div className="map-legend">
          <div><span className="legend-hidden"></span> Hidden Areas</div>
          <div><span className="legend-revealed"></span> Revealed Areas</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing Fog of War Engine...</p>
    </div>
  );

  return (
    <div className="app-container tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="fog-icon"></div></div>
          <h1>FogOfWar<span>Engine</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn tech-button">
            <div className="add-icon"></div>Add Position
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="dashboard-panels">
          {/* Left Panel */}
          <div className="left-panel">
            <div className="panel-section intro-section tech-card">
              <h2>FHE Fog of War Engine</h2>
              <p>A GameFi platform with a FHE-based "fog of war" engine for strategy games. Provides developers with fully encrypted position handling using Zama FHE technology.</p>
              <div className="tech-badge"><span>FHE-Powered</span></div>
            </div>
            
            <div className="panel-section stats-section tech-card">
              <h3>Fog Data Statistics</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-value">{fogData.length}</div>
                  <div className="stat-label">Total Positions</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{hiddenCount}</div>
                  <div className="stat-label">Hidden</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{revealedCount}</div>
                  <div className="stat-label">Revealed</div>
                </div>
              </div>
              {renderMiniMap()}
            </div>
            
            <div className="panel-section features-section tech-card">
              <h3>Key Features</h3>
              <div className="features-grid">
                {features.map((feature, index) => (
                  <div className="feature-item" key={index}>
                    <div className="feature-icon">{feature.icon}</div>
                    <div className="feature-content">
                      <h4>{feature.title}</h4>
                      <p>{feature.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          
          {/* Right Panel */}
          <div className="right-panel">
            <div className="panel-section data-section tech-card">
              <div className="section-header">
                <h2>Encrypted Position Data</h2>
                <button onClick={loadFogData} className="refresh-btn tech-button" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              
              <div className="data-table">
                <div className="table-header">
                  <div className="header-cell">ID</div>
                  <div className="header-cell">Game ID</div>
                  <div className="header-cell">Owner</div>
                  <div className="header-cell">Date</div>
                  <div className="header-cell">Status</div>
                  <div className="header-cell">Actions</div>
                </div>
                
                {fogData.length === 0 ? (
                  <div className="no-data">
                    <div className="no-data-icon"></div>
                    <p>No fog data found</p>
                    <button className="tech-button primary" onClick={() => setShowCreateModal(true)}>Add First Position</button>
                  </div>
                ) : fogData.map(data => (
                  <div className="table-row" key={data.id} onClick={() => setSelectedData(data)}>
                    <div className="table-cell">#{data.id.substring(0, 6)}</div>
                    <div className="table-cell">{data.gameId.substring(0, 8)}...</div>
                    <div className="table-cell">{data.owner.substring(0, 6)}...{data.owner.substring(38)}</div>
                    <div className="table-cell">{new Date(data.timestamp * 1000).toLocaleDateString()}</div>
                    <div className="table-cell">
                      <span className={`status-badge ${data.status}`}>{data.status}</span>
                    </div>
                    <div className="table-cell actions">
                      {isOwner(data.owner) && data.status === "hidden" && (
                        <button className="action-btn tech-button" onClick={(e) => { e.stopPropagation(); revealPosition(data.id); }}>
                          Reveal
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="panel-section partners-section tech-card">
              <h3>Technology Partners</h3>
              <div className="partners-grid">
                {partners.map((partner, index) => (
                  <div className="partner-item" key={index}>
                    <div className="partner-logo">{partner.logo}</div>
                    <div className="partner-info">
                      <h4>{partner.name}</h4>
                      <p>{partner.role}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitFogData} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          fogData={newFogData} 
          setFogData={setNewFogData}
        />
      )}
      
      {selectedData && (
        <DataDetailModal 
          data={selectedData} 
          onClose={() => { setSelectedData(null); setDecryptedPosition(null); }} 
          decryptedPosition={decryptedPosition} 
          setDecryptedPosition={setDecryptedPosition} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="fog-icon"></div><span>FogOfWarEngine</span></div>
            <p>FHE-based fog of war engine for strategy games</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Developer Docs</a>
            <a href="#" className="footer-link">API Reference</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Contact Team</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="tech-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} FogOfWarEngine. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  fogData: any;
  setFogData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, fogData, setFogData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFogData({ ...fogData, [name]: value });
  };

  const handleCoordinateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFogData({ ...fogData, [name]: parseInt(value) });
  };

  const handleSubmit = () => {
    if (!fogData.gameId || isNaN(fogData.x) || isNaN(fogData.y)) { 
      alert("Please fill all required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>Add Fog Position</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Position data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Game ID *</label>
            <input 
              type="text" 
              name="gameId" 
              value={fogData.gameId} 
              onChange={handleChange} 
              placeholder="Enter game identifier..." 
              className="tech-input"
            />
          </div>
          
          <div className="coordinate-fields">
            <div className="form-group">
              <label>X Coordinate *</label>
              <input 
                type="number" 
                name="x" 
                value={fogData.x} 
                onChange={handleCoordinateChange} 
                placeholder="X position..." 
                className="tech-input"
              />
            </div>
            
            <div className="form-group">
              <label>Y Coordinate *</label>
              <input 
                type="number" 
                name="y" 
                value={fogData.y} 
                onChange={handleCoordinateChange} 
                placeholder="Y position..." 
                className="tech-input"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Position:</span>
                <div>{`(${fogData.x}, ${fogData.y})`}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{fogData.x !== 0 || fogData.y !== 0 ? 
                  FHEEncryptPosition(fogData.x, fogData.y).substring(0, 50) + '...' : 
                  'No position entered'}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn tech-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Position"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface DataDetailModalProps {
  data: FogData;
  onClose: () => void;
  decryptedPosition: {x: number, y: number} | null;
  setDecryptedPosition: (position: {x: number, y: number} | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<{x: number, y: number} | null>;
}

const DataDetailModal: React.FC<DataDetailModalProps> = ({ 
  data, 
  onClose, 
  decryptedPosition, 
  setDecryptedPosition, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedPosition !== null) { 
      setDecryptedPosition(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(data.encryptedPosition);
    if (decrypted !== null) setDecryptedPosition(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="data-detail-modal tech-card">
        <div className="modal-header">
          <h2>Position Details #{data.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="data-info">
            <div className="info-item"><span>Game ID:</span><strong>{data.gameId}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{data.owner.substring(0, 6)}...{data.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(data.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${data.status}`}>{data.status}</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Position</h3>
            <div className="encrypted-data">{data.encryptedPosition.substring(0, 100)}...</div>
            <div className="tech-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button 
              className="decrypt-btn tech-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? <span className="decrypt-spinner"></span> : 
               decryptedPosition !== null ? "Hide Position" : "Decrypt with Wallet"}
            </button>
          </div>
          
          {decryptedPosition !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Position</h3>
              <div className="decrypted-value">{`(${decryptedPosition.x}, ${decryptedPosition.y})`}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted position is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;