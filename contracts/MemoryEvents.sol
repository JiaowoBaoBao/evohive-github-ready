// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EvoHive Memory Events (Zero-State Contract)
/// @notice Event-only contract for audit proofs. No business state is stored.
contract MemoryEvents {
    event MemoryRecorded(
        bytes32 indexed memoryHash,
        address indexed agent,
        uint64 timestamp,
        string tags,
        bytes32 cidHash
    );

    event MemoryTransferred(
        bytes32 indexed memoryHash,
        address indexed from,
        address indexed to,
        address operator
    );

    event BattleResult(
        bytes32 indexed battleId,
        address indexed winner,
        uint256 scoreA,
        uint256 scoreB,
        bytes32 resultHash
    );

    event AntiSybilFeeBurned(
        bytes32 indexed requestId,
        address indexed payer,
        address burnAddress,
        uint256 amount,
        bytes32 burnTxHash
    );

    function recordMemory(
        bytes32 memoryHash,
        address agent,
        string calldata tags,
        bytes32 cidHash
    ) external {
        emit MemoryRecorded(memoryHash, agent, uint64(block.timestamp), tags, cidHash);
    }

    function transferMemory(
        bytes32 memoryHash,
        address from,
        address to,
        address operator
    ) external {
        emit MemoryTransferred(memoryHash, from, to, operator);
    }

    function recordBattle(
        bytes32 battleId,
        address winner,
        uint256 scoreA,
        uint256 scoreB,
        bytes32 resultHash
    ) external {
        emit BattleResult(battleId, winner, scoreA, scoreB, resultHash);
    }

    function recordAntiSybilBurn(
        bytes32 requestId,
        address payer,
        address burnAddress,
        uint256 amount,
        bytes32 burnTxHash
    ) external {
        emit AntiSybilFeeBurned(requestId, payer, burnAddress, amount, burnTxHash);
    }
}
