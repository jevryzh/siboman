<template>
  <el-container class="layout-container">
    <el-aside width="220px">
      <div class="logo">逐梦 ERP</div>
      <el-menu
        :default-active="activeMenu"
        class="el-menu-vertical"
        router
      >
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <span>仪表盘</span>
        </el-menu-item>
        <el-menu-item index="/collection">
          <el-icon><Box /></el-icon>
          <span>采集箱</span>
        </el-menu-item>
        <el-menu-item index="/products">
          <el-icon><Goods /></el-icon>
          <span>商品列表</span>
        </el-menu-item>
        <el-menu-item index="/orders">
          <el-icon><ShoppingCart /></el-icon>
          <span>订单管理</span>
        </el-menu-item>
        <el-menu-item index="/analytics">
          <el-icon><PieChart /></el-icon>
          <span>类目分析</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    
    <el-container>
      <el-header>
        <div class="header-left">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentPageTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <el-select v-model="currentStoreId" placeholder="切换店铺" style="width: 200px; margin-right: 20px" @change="handleStoreChange">
            <el-option
              v-for="shop in shops"
              :key="shop.id"
              :label="shop.name"
              :value="shop.id"
            />
          </el-select>
          <el-dropdown>
            <span class="user-info">
              Admin <el-icon><ArrowDown /></el-icon>
            </span>
            <template #footer>
              <el-dropdown-menu>
                <el-dropdown-item>个人中心</el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>
      
      <el-main>
        <router-view v-slot="{ Component }">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Odometer, Box, Goods, ShoppingCart, PieChart, ArrowDown } from '@element-plus/icons-vue';
import axios from 'axios';

const route = useRoute();
const router = useRouter();
const shops = ref([]);
const currentStoreId = ref(localStorage.getItem('currentStoreId') || '');

const activeMenu = computed(() => route.path);
const currentPageTitle = computed(() => {
  const titles = {
    '/dashboard': '仪表盘',
    '/collection': '采集箱',
    '/products': '商品列表',
    '/orders': '订单管理',
    '/analytics': '类目分析',
  };
  return titles[route.path] || '';
});

const fetchShops = async () => {
  const res = await axios.get('/api/seller/shops');
  shops.value = res.data.shops;
  if (!currentStoreId.value && shops.value.length) {
    currentStoreId.value = shops.value[0].id;
    localStorage.setItem('currentStoreId', currentStoreId.value);
  }
};

const handleStoreChange = (val) => {
  localStorage.setItem('currentStoreId', val);
  window.location.reload(); // 全局刷新以应用店铺切换
};

const handleLogout = () => {
  // 登出逻辑
};

onMounted(fetchShops);
</script>

<style>
body { margin: 0; font-family: sans-serif; background: #f5f7fa; }
.layout-container { height: 100vh; }
.el-aside { background: #001529; color: #fff; }
.logo { height: 60px; line-height: 60px; text-align: center; font-size: 20px; font-weight: bold; background: #002140; }
.el-menu { border-right: none; }
.el-header { background: #fff; border-bottom: 1px solid #dcdfe6; display: flex; align-items: center; justify-content: space-between; }
.header-right { display: flex; align-items: center; }
.user-info { cursor: pointer; color: #409eff; }
</style>
