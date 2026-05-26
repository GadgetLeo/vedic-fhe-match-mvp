// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract VedicAutoMatch {
    enum MatchState { Computed, PendingConsent, Decrypting, Revealed, Rejected }

    struct Profile {
        uint256 id;
        address owner;
        bytes32 encryptedName;
        bytes32 encryptedHandle;
        uint256 createdAt;
    }

    struct Match {
        uint256 id;
        uint256 profileA;
        uint256 profileB;
        MatchState state;
        bytes32 encryptedScore;
        uint256 createdAt;
        uint256 consentedA;
        uint256 consentedB;
    }

    uint256 public nextProfileId = 1;
    uint256 public nextMatchId = 1;

    mapping(uint256 => Profile) public profiles;
    mapping(uint256 => Match) public matches;
    mapping(address => uint256[]) public userProfiles;

    event ProfileCreated(uint256 indexed profileId, address indexed owner);
    event MatchCreated(uint256 indexed matchId, uint256 profileA, uint256 profileB);
    event MatchStateChanged(uint256 indexed matchId, MatchState newState);
    event MatchScoreSubmitted(uint256 indexed matchId, bytes32 encryptedScore);

    function createProfile(bytes32 _encryptedName, bytes32 _encryptedHandle) external returns (uint256) {
        uint256 profileId = nextProfileId++;
        profiles[profileId] = Profile({
            id: profileId,
            owner: msg.sender,
            encryptedName: _encryptedName,
            encryptedHandle: _encryptedHandle,
            createdAt: block.timestamp
        });
        userProfiles[msg.sender].push(profileId);
        emit ProfileCreated(profileId, msg.sender);
        return profileId;
    }

    function getMyProfileData(uint256 profileId) external view returns (bytes32, bytes32) {
        require(profiles[profileId].owner == msg.sender, "Not owner");
        return (profiles[profileId].encryptedName, profiles[profileId].encryptedHandle);
    }

    function submitMatchScore(uint256 profileA, uint256 profileB, bytes32 encryptedScore) external returns (uint256) {
        require(profiles[profileA].owner != address(0), "Profile A not found");
        require(profiles[profileB].owner != address(0), "Profile B not found");
        
        uint256 matchId = nextMatchId++;
        matches[matchId] = Match({
            id: matchId,
            profileA: profileA,
            profileB: profileB,
            state: MatchState.Computed,
            encryptedScore: encryptedScore,
            createdAt: block.timestamp,
            consentedA: 0,
            consentedB: 0
        });
        
        emit MatchCreated(matchId, profileA, profileB);
        emit MatchScoreSubmitted(matchId, encryptedScore);
        return matchId;
    }

    function consentToReveal(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.id != 0, "Match not found");
        
        if (profiles[m.profileA].owner == msg.sender) {
            m.consentedA = 1;
        } else if (profiles[m.profileB].owner == msg.sender) {
            m.consentedB = 1;
        } else {
            revert("Not a participant");
        }
        
        if (m.consentedA == 1 && m.consentedB == 1) {
            m.state = MatchState.PendingConsent;
            emit MatchStateChanged(matchId, MatchState.PendingConsent);
        }
    }

    function getMatch(uint256 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function updateMatchState(uint256 matchId, MatchState newState) external {
        matches[matchId].state = newState;
        emit MatchStateChanged(matchId, newState);
    }

    function onDecryptionFulfilled(uint256 matchId, bytes32 decryptedNameA, bytes32 decryptedHandleA, bytes32 decryptedNameB, bytes32 decryptedHandleB) external {
        Match storage m = matches[matchId];
        m.state = MatchState.Revealed;
        emit MatchStateChanged(matchId, MatchState.Revealed);
    }
}
