#!/usr/bin/env node

'use strict';

// Comprehensive test runner for the 701 Club league database implementation
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

console.log('Starting comprehensive test suite for The 701 Club league database implementation...\n');

// Test categories
const testCategories = [
    {
        name: 'Database Schema Validation',
        file: 'database-schema.test.js',
        description: 'Tests for database schema, tables, relationships, and data types'
    },
    {
        name: 'API Endpoint Functionality',
        file: 'api-endpoints.test.js',
        description: 'Tests for API endpoint functionality, authentication, and response handling'
    },
    {
        name: 'Report Generation',
        file: 'report-generation.test.js',
        description: 'Tests for report correctness and data integrity in generated reports'
    },
    {
        name: 'Admin Dashboard Features',
        file: 'admin-dashboard.test.js',
        description: 'Tests for admin dashboard functionality including score review, team management, and schedule editing'
    },
    {
        name: 'Data Integrity',
        file: 'data-integrity.test.js',
        description: 'Tests for data integrity checks and no data loss during operations'
    }
];

// Run individual tests
async function runIndividualTests() {
    console.log('Running individual test files...\n');
    
    let passed = 0;
    let failed = 0;
    
    for (const category of testCategories) {
        try {
            console.log(`\n--- ${category.name} ---`);
            console.log(category.description);
            
            // Run the specific test file
            const result = execSync(`node tests/${category.file}`, { encoding: 'utf8' });
            console.log(`✓ ${category.name} - PASSED`);
            passed++;
        } catch (error) {
            console.log(`✗ ${category.name} - FAILED`);
            console.error(error.message);
            failed++;
        }
    }
    
    return { passed, failed };
}

// Run all tests together using Node.js built-in test runner
async function runAllTests() {
    console.log('\nRunning all tests with Node.js test runner...\n');
    
    try {
        const result = execSync('node --test tests/*.test.js', { encoding: 'utf8' });
        console.log('\n✓ All tests completed successfully!');
        return true;
    } catch (error) {
        console.error('\n✗ Some tests failed:');
        console.error(error.message);
        return false;
    }
}

// Generate test summary
async function generateSummary(passed, failed) {
    const total = passed + failed;
    
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUITE SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${total}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    
    if (failed === 0) {
        console.log('\n🎉 ALL TESTS PASSED! The league database implementation is working correctly.');
    } else {
        console.log('\n⚠️  Some tests failed. Please review the failures above.');
    }
    
    console.log('='.repeat(60));
}

// Main test runner function
async function main() {
    console.log('🧪 The 701 Club League Database Test Suite');
    console.log('==========================================\n');
    
    // First, check if we have the necessary test files
    const missingFiles = [];
    for (const category of testCategories) {
        const filePath = path.join(__dirname, 'tests', category.file);
        if (!fs.existsSync(filePath)) {
            missingFiles.push(category.file);
        }
    }
    
    if (missingFiles.length > 0) {
        console.error('❌ Missing test files:');
        missingFiles.forEach(file => console.error(`  - ${file}`));
        process.exit(1);
    }
    
    // Run individual tests
    const { passed, failed } = await runIndividualTests();
    
    // Run all tests together
    const allTestsPassed = await runAllTests();
    
    // Generate summary
    await generateSummary(passed, failed);
    
    if (failed === 0 && allTestsPassed) {
        console.log('\n✅ All tests passed successfully! The implementation is ready.');
        process.exit(0);
    } else {
        console.log('\n❌ Some tests failed. Please fix the issues before deployment.');
        process.exit(1);
    }
}

// Run the test suite
main().catch(error => {
    console.error('Error running test suite:', error);
    process.exit(1);
});