// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract HoroscopeMatcher {
    uint16 public constant REVEAL_THRESHOLD = 70;

    struct Profile {
        string displayName;
        string xHandle;
        string avatarColor;
        uint64 createdAt;
        uint64 version;
        bool exists;
    }

    struct ChartInput {
        InEuint8 moonSign;
        InEuint8 nakshatra;
        InEuint8 ascSign;
        InEuint8 sunSign;
        InEuint8 venusSign;
        InEuint8 marsSign;
        InEuint8 jupiterSign;
        InEuint8 saturnSign;
        InEuint8 seventhHouseSign;
        InEuint8 venusHouse;
        InEuint8 marsHouse;
    }

    struct Chart {
        euint8 moonSign;
        euint8 nakshatra;
        euint8 ascSign;
        euint8 sunSign;
        euint8 venusSign;
        euint8 marsSign;
        euint8 jupiterSign;
        euint8 saturnSign;
        euint8 seventhHouseSign;
        euint8 venusHouse;
        euint8 marsHouse;
        bool exists;
    }

    struct PairRecord {
        address userA;
        address userB;
        uint64 computedAt;
        uint64 profileVersionA;
        uint64 profileVersionB;
        bool computed;
        bool revealA;
        bool revealB;
    }

    mapping(address => Profile) public profiles;
    mapping(address => Chart) private charts;
    mapping(bytes32 => euint16) private scores;
    mapping(bytes32 => PairRecord) public pairs;
    mapping(address => bytes32[]) private userPairKeys;
    address[] public members;

    event ProfileSaved(address indexed user, string displayName, string xHandle, uint64 version);
    event ChartEncrypted(address indexed user);
    event CompatibilityComputed(address indexed userA, address indexed userB, euint16 scoreHandle);
    event RevealRequested(address indexed user, address indexed other);
    event RevealReady(address indexed userA, address indexed userB);

    function saveProfile(
        string calldata displayName,
        string calldata xHandle,
        string calldata avatarColor,
        ChartInput calldata encryptedChart
    ) external {
        bool isNewProfile = !profiles[msg.sender].exists;
        uint64 nextVersion = profiles[msg.sender].version + 1;

        if (isNewProfile) {
            members.push(msg.sender);
        }

        profiles[msg.sender] = Profile({
            displayName: displayName,
            xHandle: xHandle,
            avatarColor: avatarColor,
            createdAt: uint64(block.timestamp),
            version: nextVersion,
            exists: true
        });

        Chart storage chart = charts[msg.sender];
        chart.moonSign = FHE.asEuint8(encryptedChart.moonSign);
        chart.nakshatra = FHE.asEuint8(encryptedChart.nakshatra);
        chart.ascSign = FHE.asEuint8(encryptedChart.ascSign);
        chart.sunSign = FHE.asEuint8(encryptedChart.sunSign);
        chart.venusSign = FHE.asEuint8(encryptedChart.venusSign);
        chart.marsSign = FHE.asEuint8(encryptedChart.marsSign);
        chart.jupiterSign = FHE.asEuint8(encryptedChart.jupiterSign);
        chart.saturnSign = FHE.asEuint8(encryptedChart.saturnSign);
        chart.seventhHouseSign = FHE.asEuint8(encryptedChart.seventhHouseSign);
        chart.venusHouse = FHE.asEuint8(encryptedChart.venusHouse);
        chart.marsHouse = FHE.asEuint8(encryptedChart.marsHouse);
        chart.exists = true;

        _allowChart(msg.sender);

        emit ProfileSaved(msg.sender, displayName, xHandle, nextVersion);
        emit ChartEncrypted(msg.sender);
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function hasEncryptedChart(address user) external view returns (bool) {
        return charts[user].exists;
    }

    function computeCompatibility(address other) external returns (euint16) {
        return _computeCompatibility(msg.sender, other);
    }

    function computeCompatibilityFor(address userA, address userB) external returns (euint16) {
        return _computeCompatibility(userA, userB);
    }

    function getScore(address userA, address userB) external view returns (euint16) {
        return scores[_pairKey(userA, userB)];
    }

    function userPairCount(address user) external view returns (uint256) {
        return userPairKeys[user].length;
    }

    function userPairKeyAt(address user, uint256 index) external view returns (bytes32) {
        return userPairKeys[user][index];
    }

    function getPair(address userA, address userB) external view returns (PairRecord memory) {
        return pairs[_pairKey(userA, userB)];
    }

    function getPairByKey(bytes32 key) external view returns (PairRecord memory) {
        return pairs[key];
    }

    function requestReveal(address other) external {
        bytes32 key = _pairKey(msg.sender, other);
        PairRecord storage pair = pairs[key];
        require(pair.computed, "PAIR_NOT_COMPUTED");
        require(msg.sender == pair.userA || msg.sender == pair.userB, "NOT_PAIR_MEMBER");

        if (msg.sender == pair.userA) {
            pair.revealA = true;
        } else {
            pair.revealB = true;
        }

        emit RevealRequested(msg.sender, other);

        if (pair.revealA && pair.revealB) {
            FHE.allow(scores[key], pair.userA);
            FHE.allow(scores[key], pair.userB);
            emit RevealReady(pair.userA, pair.userB);
        }
    }

    function bothRevealed(address userA, address userB) public view returns (bool) {
        PairRecord storage pair = pairs[_pairKey(userA, userB)];
        return pair.computed && pair.revealA && pair.revealB;
    }

    function getPublicRevealScore(address userA, address userB) external returns (euint16) {
        if (!bothRevealed(userA, userB)) {
            euint16 hidden = FHE.asEuint16(0);
            FHE.allowPublic(hidden);
            FHE.allowThis(hidden);
            return hidden;
        }

        euint16 score = scores[_pairKey(userA, userB)];
        ebool canReveal = FHE.gte(score, FHE.asEuint16(REVEAL_THRESHOLD));
        euint16 revealed = FHE.select(canReveal, score, FHE.asEuint16(0));
        FHE.allowPublic(revealed);
        FHE.allowThis(revealed);
        return revealed;
    }

    function _computeCompatibility(address userA, address userB) private returns (euint16) {
        require(userA != userB, "SELF_MATCH");
        require(charts[userA].exists, "USER_A_CHART_MISSING");
        require(charts[userB].exists, "USER_B_CHART_MISSING");

        bytes32 key = _pairKey(userA, userB);
        PairRecord storage pair = pairs[key];
        bool isNewPair = !pair.computed;
        euint16 score = _score(charts[userA], charts[userB]);
        (address orderedA, address orderedB) = _orderedPair(userA, userB);

        scores[key] = score;
        pairs[key] = PairRecord({
            userA: orderedA,
            userB: orderedB,
            computedAt: uint64(block.timestamp),
            profileVersionA: profiles[orderedA].version,
            profileVersionB: profiles[orderedB].version,
            computed: true,
            revealA: false,
            revealB: false
        });

        FHE.allowThis(scores[key]);

        if (isNewPair) {
            userPairKeys[orderedA].push(key);
            userPairKeys[orderedB].push(key);
        }

        emit CompatibilityComputed(orderedA, orderedB, score);
        return score;
    }

    function _score(Chart storage a, Chart storage b) private returns (euint16) {
        euint16 score = FHE.asEuint16(0);

        score = FHE.add(score, _award(FHE.eq(a.moonSign, b.moonSign), 20));
        score = FHE.add(score, _award(FHE.eq(a.nakshatra, b.nakshatra), 20));
        score = FHE.add(score, _award(FHE.eq(a.ascSign, b.ascSign), 10));
        score = FHE.add(score, _award(FHE.eq(a.venusSign, b.marsSign), 8));
        score = FHE.add(score, _award(FHE.eq(b.venusSign, a.marsSign), 7));
        score = FHE.add(score, _award(FHE.eq(a.seventhHouseSign, b.ascSign), 8));
        score = FHE.add(score, _award(FHE.eq(b.seventhHouseSign, a.ascSign), 7));
        score = FHE.add(score, _award(FHE.eq(a.jupiterSign, b.jupiterSign), 5));
        score = FHE.add(score, _award(FHE.eq(a.saturnSign, b.saturnSign), 5));
        score = FHE.add(score, _award(FHE.eq(a.venusHouse, b.marsHouse), 5));
        score = FHE.add(score, _award(FHE.eq(b.venusHouse, a.marsHouse), 5));

        return score;
    }

    function _award(ebool condition, uint16 points) private returns (euint16) {
        return FHE.select(condition, FHE.asEuint16(points), FHE.asEuint16(0));
    }

    function _allowChart(address user) private {
        Chart storage chart = charts[user];
        FHE.allowThis(chart.moonSign);
        FHE.allowThis(chart.nakshatra);
        FHE.allowThis(chart.ascSign);
        FHE.allowThis(chart.sunSign);
        FHE.allowThis(chart.venusSign);
        FHE.allowThis(chart.marsSign);
        FHE.allowThis(chart.jupiterSign);
        FHE.allowThis(chart.saturnSign);
        FHE.allowThis(chart.seventhHouseSign);
        FHE.allowThis(chart.venusHouse);
        FHE.allowThis(chart.marsHouse);

        FHE.allowSender(chart.moonSign);
        FHE.allowSender(chart.nakshatra);
        FHE.allowSender(chart.ascSign);
        FHE.allowSender(chart.sunSign);
        FHE.allowSender(chart.venusSign);
        FHE.allowSender(chart.marsSign);
        FHE.allowSender(chart.jupiterSign);
        FHE.allowSender(chart.saturnSign);
        FHE.allowSender(chart.seventhHouseSign);
        FHE.allowSender(chart.venusHouse);
        FHE.allowSender(chart.marsHouse);
    }

    function _pairKey(address userA, address userB) private pure returns (bytes32) {
        (address orderedA, address orderedB) = _orderedPair(userA, userB);
        return keccak256(abi.encodePacked(orderedA, orderedB));
    }

    function _orderedPair(address userA, address userB) private pure returns (address, address) {
        return userA < userB ? (userA, userB) : (userB, userA);
    }
}
