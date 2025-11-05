pragma solidity ^0.8.24;

import { FHE, euint32, externalEuint32 } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AccessGate is ZamaEthereumConfig {
    struct Asset {
        euint32 encryptedBalance;
        uint256 publicData;
        address owner;
        bool isVerified;
        uint32 decryptedBalance;
    }

    mapping(string => Asset) private assets;
    string[] private assetIds;

    event AssetRegistered(string indexed assetId, address indexed owner);
    event VerificationCompleted(string indexed assetId, uint32 decryptedBalance);

    constructor() ZamaEthereumConfig() {}

    function registerAsset(
        string calldata assetId,
        externalEuint32 encryptedBalance,
        bytes calldata registrationProof,
        uint256 publicData
    ) external {
        require(assets[assetId].owner == address(0), "Asset already registered");
        require(FHE.isInitialized(FHE.fromExternal(encryptedBalance, registrationProof)), "Invalid encrypted balance");

        assets[assetId] = Asset({
            encryptedBalance: FHE.fromExternal(encryptedBalance, registrationProof),
            publicData: publicData,
            owner: msg.sender,
            isVerified: false,
            decryptedBalance: 0
        });

        FHE.allowThis(assets[assetId].encryptedBalance);
        FHE.makePubliclyDecryptable(assets[assetId].encryptedBalance);

        assetIds.push(assetId);
        emit AssetRegistered(assetId, msg.sender);
    }

    function verifyAsset(
        string calldata assetId,
        bytes memory abiEncodedClearBalance,
        bytes memory verificationProof
    ) external {
        require(assets[assetId].owner != address(0), "Asset not found");
        require(!assets[assetId].isVerified, "Asset already verified");

        bytes32[] memory ciphertexts = new bytes32[](1);
        ciphertexts[0] = FHE.toBytes32(assets[assetId].encryptedBalance);

        FHE.checkSignatures(ciphertexts, abiEncodedClearBalance, verificationProof);

        uint32 clearBalance = abi.decode(abiEncodedClearBalance, (uint32));
        assets[assetId].decryptedBalance = clearBalance;
        assets[assetId].isVerified = true;

        emit VerificationCompleted(assetId, clearBalance);
    }

    function getAsset(string calldata assetId) external view returns (
        uint256 publicData,
        address owner,
        bool isVerified,
        uint32 decryptedBalance
    ) {
        require(assets[assetId].owner != address(0), "Asset not found");
        Asset storage asset = assets[assetId];
        return (asset.publicData, asset.owner, asset.isVerified, asset.decryptedBalance);
    }

    function getEncryptedBalance(string calldata assetId) external view returns (euint32) {
        require(assets[assetId].owner != address(0), "Asset not found");
        return assets[assetId].encryptedBalance;
    }

    function getAllAssetIds() external view returns (string[] memory) {
        return assetIds;
    }

    function checkAccess(
        string calldata assetId,
        uint32 requiredBalance
    ) external view returns (bool) {
        require(assets[assetId].owner != address(0), "Asset not found");
        require(assets[assetId].isVerified, "Asset not verified");
        return assets[assetId].decryptedBalance >= requiredBalance;
    }

    function isOperational() public pure returns (bool) {
        return true;
    }
}


