// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title NexusLedgerAnchor
/// @notice Append-only on-chain anchor for the Nexus agent trade ledger.
/// A trusted off-chain signer (the nexus-ledger-anchor Worker) periodically
/// commits the SHA-256 root of the canonical agent_trades ledger. Once written,
/// history cannot be rewritten — anyone can recompute the ledger hash from the
/// public /agents/ledger endpoint and check it against the on-chain `Anchored`
/// event log. This is what turns "tamper-evident" into "tamper-proof".
contract NexusLedgerAnchor {
    address public owner;
    uint256 public anchorCount;
    bytes32 public latestRoot;
    uint256 public latestRecordCount;
    uint256 public latestTimestamp;

    /// @param index       monotonically increasing anchor number
    /// @param root        SHA-256 root of the canonical ledger (bytes32)
    /// @param recordCount number of trade records covered by this root
    /// @param timestamp   block time of the anchor
    event Anchored(uint256 indexed index, bytes32 indexed root, uint256 recordCount, uint256 timestamp);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Commit a new ledger root. Only the owner (anchor signer) may call.
    function anchor(bytes32 root, uint256 recordCount) external onlyOwner {
        anchorCount += 1;
        latestRoot = root;
        latestRecordCount = recordCount;
        latestTimestamp = block.timestamp;
        emit Anchored(anchorCount, root, recordCount, block.timestamp);
    }

    /// @notice Hand the anchoring right to a new signer (e.g. key rotation).
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
