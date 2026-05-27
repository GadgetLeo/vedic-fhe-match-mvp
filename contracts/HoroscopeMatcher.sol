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

    mapping(address => Profile) public profiles;
    mapping(address => Chart) private charts;
    mapping(bytes32 => euint16) private scores;
    address[] public members;

    event ProfileSaved(address indexed user, string displayName, string xHandle);
    event ChartEncrypted(address indexed user);
    event CompatibilityComputed(address indexed userA, address indexed userB, euint16 scoreHandle);

    function saveProfile(
        string calldata displayName,
        string calldata xHandle,
        string calldata avatarColor,
        ChartInput calldata encryptedChart
    ) external {
        if (!profiles[msg.sender].exists) {
            members.push(msg.sender);
        }

        profiles[msg.sender] = Profile({
            displayName: displayName,
            xHandle: xHandle,
            avatarColor: avatarColor,
            createdAt: uint64(block.timestamp),
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

        emit ProfileSaved(msg.sender, displayName, xHandle);
        emit ChartEncrypted(msg.sender);
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function hasEncryptedChart(address user) external view returns (bool) {
        return charts[user].exists;
    }

    function computeCompatibility(address other) external returns (euint16) {
        require(msg.sender != other, "SELF_MATCH");
        require(charts[msg.sender].exists, "SENDER_CHART_MISSING");
        require(charts[other].exists, "OTHER_CHART_MISSING");

        euint16 score = _score(charts[msg.sender], charts[other]);
        bytes32 key = _pairKey(msg.sender, other);
        scores[key] = score;

        FHE.allowThis(scores[key]);
        FHE.allow(scores[key], msg.sender);
        FHE.allow(scores[key], other);

        emit CompatibilityComputed(msg.sender, other, score);
        return score;
    }

    function getScore(address userA, address userB) external view returns (euint16) {
        return scores[_pairKey(userA, userB)];
    }

    function getPublicRevealScore(address userA, address userB) external returns (euint16) {
        euint16 score = scores[_pairKey(userA, userB)];
        ebool canReveal = FHE.gte(score, FHE.asEuint16(REVEAL_THRESHOLD));
        euint16 revealed = FHE.select(canReveal, score, FHE.asEuint16(0));
        FHE.allowPublic(revealed);
        FHE.allowThis(revealed);
        return revealed;
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
        return userA < userB
            ? keccak256(abi.encodePacked(userA, userB))
            : keccak256(abi.encodePacked(userB, userA));
    }
}
