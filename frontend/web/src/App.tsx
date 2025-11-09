import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { getContractReadOnly, getContractWithSigner } from "./components/useContract";
import "./App.css";
import { useAccount } from 'wagmi';
import { useFhevm, useEncrypt, useDecrypt } from '../fhevm-sdk/src';

interface AccessData {
  id: string;
  name: string;
  encryptedValue: string;
  publicValue1: number;
  publicValue2: number;
  description: string;
  creator: string;
  timestamp: number;
  isVerified: boolean;
  decryptedValue?: number;
}

interface UserHistory {
  action: string;
  timestamp: number;
  target: string;
  status: string;
}

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const [loading, setLoading] = useState(true);
  const [accessData, setAccessData] = useState<AccessData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creatingData, setCreatingData] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ 
    visible: false, 
    status: "pending", 
    message: "" 
  });
  const [newAccessData, setNewAccessData] = useState({ name: "", value: "", description: "" });
  const [selectedData, setSelectedData] = useState<AccessData | null>(null);
  const [userHistory, setUserHistory] = useState<UserHistory[]>([]);
  const [stats, setStats] = useState({ total: 0, verified: 0, today: 0 });
  const [activeTab, setActiveTab] = useState("dashboard");
  const [searchTerm, setSearchTerm] = useState("");

  const { status, initialize, isInitialized } = useFhevm();
  const { encrypt, isEncrypting } = useEncrypt();
  const { verifyDecryption, isDecrypting } = useDecrypt();

  useEffect(() => {
    const initFhevm = async () => {
      if (!isConnected || isInitialized) return;
      try {
        await initialize();
      } catch (error) {
        console.error('FHEVM init failed:', error);
      }
    };
    initFhevm();
  }, [isConnected, isInitialized, initialize]);

  useEffect(() => {
    const loadData = async () => {
      if (!isConnected) {
        setLoading(false);
        return;
      }
      try {
        await loadAccessData();
        loadUserHistory();
        calculateStats();
      } catch (error) {
        console.error('Load failed:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [isConnected]);

  const loadAccessData = async () => {
    if (!isConnected) return;
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const businessIds = await contract.getAllBusinessIds();
      const dataList: AccessData[] = [];
      
      for (const id of businessIds) {
        try {
          const data = await contract.getBusinessData(id);
          dataList.push({
            id,
            name: data.name,
            encryptedValue: id,
            publicValue1: Number(data.publicValue1) || 0,
            publicValue2: Number(data.publicValue2) || 0,
            description: data.description,
            creator: data.creator,
            timestamp: Number(data.timestamp),
            isVerified: data.isVerified,
            decryptedValue: Number(data.decryptedValue) || 0
          });
        } catch (e) {
          console.error('Error loading data:', e);
        }
      }
      setAccessData(dataList);
    } catch (e) {
      showTransactionStatus("error", "Failed to load data");
    } finally { 
      setIsRefreshing(false); 
    }
  };

  const createAccessData = async () => {
    if (!isConnected || !address) { 
      showTransactionStatus("error", "Please connect wallet first");
      return; 
    }
    
    setCreatingData(true);
    showTransactionStatus("pending", "Creating encrypted access data...");
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Contract not available");
      
      const value = parseInt(newAccessData.value) || 0;
      const businessId = `access-${Date.now()}`;
      
      const encryptedResult = await encrypt(await contract.getAddress(), address, value);
      
      const tx = await contract.createBusinessData(
        businessId,
        newAccessData.name,
        encryptedResult.encryptedData,
        encryptedResult.proof,
        0,
        0,
        newAccessData.description
      );
      
      showTransactionStatus("pending", "Waiting for confirmation...");
      await tx.wait();
      
      addUserHistory("CREATE", businessId, "success");
      showTransactionStatus("success", "Access data created!");
      setTimeout(() => setTransactionStatus({ ...transactionStatus, visible: false }), 2000);
      
      await loadAccessData();
      setShowCreateModal(false);
      setNewAccessData({ name: "", value: "", description: "" });
    } catch (e: any) {
      const message = e.message?.includes("rejected") ? "Transaction rejected" : "Creation failed";
      showTransactionStatus("error", message);
      addUserHistory("CREATE", "new data", "failed");
    } finally { 
      setCreatingData(false); 
    }
  };

  const decryptData = async (businessId: string): Promise<number | null> => {
    if (!isConnected || !address) { 
      showTransactionStatus("error", "Please connect wallet first");
      return null; 
    }
    
    try {
      const contractRead = await getContractReadOnly();
      if (!contractRead) return null;
      
      const data = await contractRead.getBusinessData(businessId);
      if (data.isVerified) {
        showTransactionStatus("success", "Data already verified");
        return Number(data.decryptedValue) || 0;
      }
      
      const contractWrite = await getContractWithSigner();
      if (!contractWrite) return null;
      
      const encryptedValueHandle = await contractRead.getEncryptedValue(businessId);
      
      const result = await verifyDecryption(
        [encryptedValueHandle],
        await contractWrite.getAddress(),
        (abiEncodedClearValues: string, decryptionProof: string) => 
          contractWrite.verifyDecryption(businessId, abiEncodedClearValues, decryptionProof)
      );
      
      showTransactionStatus("pending", "Verifying decryption...");
      
      const clearValue = result.decryptionResult.clearValues[encryptedValueHandle];
      
      await loadAccessData();
      addUserHistory("DECRYPT", businessId, "success");
      showTransactionStatus("success", "Data decrypted successfully!");
      setTimeout(() => setTransactionStatus({ ...transactionStatus, visible: false }), 2000);
      
      return Number(clearValue);
    } catch (e: any) { 
      if (e.message?.includes("already verified")) {
        showTransactionStatus("success", "Data verified");
        await loadAccessData();
        return null;
      }
      showTransactionStatus("error", "Decryption failed");
      addUserHistory("DECRYPT", businessId, "failed");
      return null; 
    }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const available = await contract.isAvailable();
      showTransactionStatus("success", `System available: ${available}`);
      addUserHistory("CHECK_AVAILABILITY", "system", "success");
    } catch (e) {
      showTransactionStatus("error", "Availability check failed");
    }
  };

  const showTransactionStatus = (status: "pending" | "success" | "error", message: string) => {
    setTransactionStatus({ visible: true, status, message });
    setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
  };

  const addUserHistory = (action: string, target: string, status: string) => {
    const history: UserHistory = {
      action,
      timestamp: Date.now(),
      target,
      status
    };
    setUserHistory(prev => [history, ...prev.slice(0, 9)]);
  };

  const loadUserHistory = () => {
    const mockHistory: UserHistory[] = [
      { action: "VIEW", timestamp: Date.now() - 1000, target: "dashboard", status: "success" },
      { action: "REFRESH", timestamp: Date.now() - 5000, target: "data", status: "success" }
    ];
    setUserHistory(mockHistory);
  };

  const calculateStats = () => {
    const total = accessData.length;
    const verified = accessData.filter(d => d.isVerified).length;
    const today = accessData.filter(d => 
      new Date(d.timestamp * 1000).toDateString() === new Date().toDateString()
    ).length;
    setStats({ total, verified, today });
  };

  useEffect(() => {
    calculateStats();
  }, [accessData]);

  const filteredData = accessData.filter(data =>
    data.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    data.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!isConnected) {
    return (
      <div className="app-container">
        <header className="app-header">
          <div className="logo-section">
            <div className="logo-icon">⚡</div>
            <h1>AccessGate_Z</h1>
          </div>
          <ConnectButton />
        </header>
        
        <div className="connection-prompt">
          <div className="metal-card">
            <div className="card-icon">🔐</div>
            <h2>FHE加密门禁系统</h2>
            <p>连接钱包开启全同态加密内容访问验证</p>
            <div className="feature-grid">
              <div className="feature-item">
                <span className="feature-icon">🛡️</span>
                <span>资产隐私保护</span>
              </div>
              <div className="feature-item">
                <span className="feature-icon">⚡</span>
                <span>即时验证</span>
              </div>
              <div className="feature-item">
                <span className="feature-icon">🔒</span>
                <span>加密计算</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!isInitialized) {
    return (
      <div className="loading-screen">
        <div className="metal-spinner"></div>
        <p>初始化FHE加密系统...</p>
      </div>
    );
  }

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>加载加密访问数据...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon">⚡</div>
          <h1>AccessGate_Z</h1>
        </div>
        
        <nav className="main-nav">
          <button 
            className={`nav-btn ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            📊 控制台
          </button>
          <button 
            className={`nav-btn ${activeTab === "access" ? "active" : ""}`}
            onClick={() => setActiveTab("access")}
          >
            🔐 访问管理
          </button>
          <button 
            className={`nav-btn ${activeTab === "history" ? "active" : ""}`}
            onClick={() => setActiveTab("history")}
          >
            📋 操作记录
          </button>
          <button 
            className={`nav-btn ${activeTab === "faq" ? "active" : ""}`}
            onClick={() => setActiveTab("faq")}
          >
            ❓ 帮助
          </button>
        </nav>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="primary-btn metal-glow"
          >
            + 新建访问规则
          </button>
          <ConnectButton />
        </div>
      </header>

      <main className="main-content">
        {activeTab === "dashboard" && (
          <div className="dashboard-tab">
            <div className="stats-grid">
              <div className="stat-card metal-card">
                <div className="stat-icon">📊</div>
                <div className="stat-value">{stats.total}</div>
                <div className="stat-label">总访问规则</div>
              </div>
              <div className="stat-card metal-card">
                <div className="stat-icon">✅</div>
                <div className="stat-value">{stats.verified}</div>
                <div className="stat-label">已验证数据</div>
              </div>
              <div className="stat-card metal-card">
                <div className="stat-icon">🆕</div>
                <div className="stat-value">{stats.today}</div>
                <div className="stat-label">今日新增</div>
              </div>
            </div>

            <div className="action-panel metal-card">
              <h3>快速操作</h3>
              <div className="action-buttons">
                <button onClick={checkAvailability} className="action-btn">
                  检查系统状态
                </button>
                <button onClick={loadAccessData} className="action-btn">
                  刷新数据
                </button>
                <button onClick={() => setActiveTab("access")} className="action-btn">
                  管理访问规则
                </button>
              </div>
            </div>

            <div className="chart-panel metal-card">
              <h3>数据验证统计</h3>
              <div className="verification-chart">
                <div className="chart-bar">
                  <div 
                    className="bar-fill verified" 
                    style={{ width: `${stats.total ? (stats.verified / stats.total) * 100 : 0}%` }}
                  >
                    <span>已验证 {stats.verified}</span>
                  </div>
                </div>
                <div className="chart-labels">
                  <span>未验证: {stats.total - stats.verified}</span>
                  <span>验证率: {stats.total ? Math.round((stats.verified / stats.total) * 100) : 0}%</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "access" && (
          <div className="access-tab">
            <div className="tab-header">
              <div className="search-section">
                <input
                  type="text"
                  placeholder="搜索访问规则..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="search-input metal-input"
                />
              </div>
              <button onClick={loadAccessData} className="refresh-btn">
                🔄 刷新
              </button>
            </div>

            <div className="data-grid">
              {filteredData.length === 0 ? (
                <div className="empty-state metal-card">
                  <div className="empty-icon">🔍</div>
                  <p>暂无访问规则</p>
                  <button 
                    onClick={() => setShowCreateModal(true)}
                    className="primary-btn"
                  >
                    创建第一条规则
                  </button>
                </div>
              ) : (
                filteredData.map((data) => (
                  <div key={data.id} className="data-card metal-card">
                    <div className="card-header">
                      <h4>{data.name}</h4>
                      <span className={`status-badge ${data.isVerified ? "verified" : "pending"}`}>
                        {data.isVerified ? "✅ 已验证" : "⏳ 待验证"}
                      </span>
                    </div>
                    <p className="card-desc">{data.description}</p>
                    <div className="card-meta">
                      <span>创建者: {data.creator.substring(0, 8)}...</span>
                      <span>时间: {new Date(data.timestamp * 1000).toLocaleDateString()}</span>
                    </div>
                    <div className="card-actions">
                      <button 
                        onClick={async () => {
                          const result = await decryptData(data.id);
                          if (result !== null) {
                            setSelectedData({...data, decryptedValue: result});
                          }
                        }}
                        className={`action-btn ${data.isVerified ? "verified" : ""}`}
                      >
                        {data.isVerified ? "查看数据" : "验证解密"}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="history-tab">
            <h3>操作记录</h3>
            <div className="history-list">
              {userHistory.map((record, index) => (
                <div key={index} className="history-item metal-card">
                  <div className="history-action">{record.action}</div>
                  <div className="history-target">{record.target}</div>
                  <div className="history-time">
                    {new Date(record.timestamp).toLocaleString()}
                  </div>
                  <div className={`history-status ${record.status}`}>
                    {record.status === "success" ? "✅" : "❌"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "faq" && (
          <div className="faq-tab">
            <div className="faq-list">
              <div className="faq-item metal-card">
                <h4>什么是FHE同态加密？</h4>
                <p>全同态加密允许在加密数据上直接进行计算，无需解密即可验证条件，保护用户隐私。</p>
              </div>
              <div className="faq-item metal-card">
                <h4>如何创建访问规则？</h4>
                <p>点击"新建访问规则"按钮，输入规则名称和加密数值，系统会自动进行FHE加密处理。</p>
              </div>
              <div className="faq-item metal-card">
                <h4>数据验证过程是怎样的？</h4>
                <p>验证时系统会在本地解密数据，然后提交证明到区块链进行验证，确保数据真实性。</p>
              </div>
            </div>
          </div>
        )}
      </main>

      {showCreateModal && (
        <CreateModal 
          onSubmit={createAccessData}
          onClose={() => setShowCreateModal(false)}
          creating={creatingData}
          data={newAccessData}
          setData={setNewAccessData}
          isEncrypting={isEncrypting}
        />
      )}

      {selectedData && (
        <DetailModal
          data={selectedData}
          onClose={() => setSelectedData(null)}
          onDecrypt={decryptData}
          isDecrypting={isDecrypting}
        />
      )}

      {transactionStatus.visible && (
        <div className={`transaction-toast ${transactionStatus.status}`}>
          <div className="toast-content">
            <span className="toast-icon">
              {transactionStatus.status === "pending" && "⏳"}
              {transactionStatus.status === "success" && "✅"}
              {transactionStatus.status === "error" && "❌"}
            </span>
            {transactionStatus.message}
          </div>
        </div>
      )}
    </div>
  );
};

const CreateModal: React.FC<{
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  data: any;
  setData: (data: any) => void;
  isEncrypting: boolean;
}> = ({ onSubmit, onClose, creating, data, setData, isEncrypting }) => {
  return (
    <div className="modal-overlay">
      <div className="modal-content metal-card">
        <div className="modal-header">
          <h3>创建访问规则</h3>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="modal-body">
          <div className="form-group">
            <label>规则名称</label>
            <input
              type="text"
              value={data.name}
              onChange={(e) => setData({...data, name: e.target.value})}
              className="metal-input"
              placeholder="输入规则名称..."
            />
          </div>
          
          <div className="form-group">
            <label>加密数值 (整数)</label>
            <input
              type="number"
              value={data.value}
              onChange={(e) => setData({...data, value: e.target.value})}
              className="metal-input"
              placeholder="输入要加密的数值..."
            />
            <div className="input-hint">FHE加密整数数据</div>
          </div>
          
          <div className="form-group">
            <label>规则描述</label>
            <textarea
              value={data.description}
              onChange={(e) => setData({...data, description: e.target.value})}
              className="metal-input"
              placeholder="输入规则描述..."
              rows={3}
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="secondary-btn">取消</button>
          <button 
            onClick={onSubmit}
            disabled={creating || isEncrypting || !data.name || !data.value}
            className="primary-btn metal-glow"
          >
            {creating || isEncrypting ? "加密处理中..." : "创建规则"}
          </button>
        </div>
      </div>
    </div>
  );
};

const DetailModal: React.FC<{
  data: AccessData;
  onClose: () => void;
  onDecrypt: (id: string) => Promise<number | null>;
  isDecrypting: boolean;
}> = ({ data, onClose, onDecrypt, isDecrypting }) => {
  return (
    <div className="modal-overlay">
      <div className="modal-content metal-card large">
        <div className="modal-header">
          <h3>访问规则详情</h3>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="modal-body">
          <div className="detail-section">
            <div className="detail-row">
              <span>规则名称:</span>
              <strong>{data.name}</strong>
            </div>
            <div className="detail-row">
              <span>创建者:</span>
              <span>{data.creator}</span>
            </div>
            <div className="detail-row">
              <span>创建时间:</span>
              <span>{new Date(data.timestamp * 1000).toLocaleString()}</span>
            </div>
            <div className="detail-row">
              <span>验证状态:</span>
              <span className={`status ${data.isVerified ? "verified" : "pending"}`}>
                {data.isVerified ? "✅ 已验证" : "⏳ 待验证"}
              </span>
            </div>
          </div>
          
          <div className="data-section">
            <h4>加密数据</h4>
            <div className="encrypted-data">
              {data.isVerified ? (
                <div className="decrypted-value">
                  <span>解密数值: </span>
                  <strong>{data.decryptedValue}</strong>
                </div>
              ) : (
                <div className="encrypted-value">
                  <span>🔒 FHE加密数据</span>
                  <button 
                    onClick={() => onDecrypt(data.id)}
                    disabled={isDecrypting}
                    className="decrypt-btn metal-glow"
                  >
                    {isDecrypting ? "解密中..." : "验证解密"}
                  </button>
                </div>
              )}
            </div>
          </div>
          
          <div className="description-section">
            <h4>规则描述</h4>
            <p>{data.description}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;


